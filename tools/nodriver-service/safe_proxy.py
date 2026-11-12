"""Small local CONNECT proxy that pins validated DNS answers for Chromium."""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional, Sequence, Tuple

from security import URLPolicyError, normalize_domains, validate_proxy_target

logger = logging.getLogger("nodriver_service.proxy")
Connector = Callable[[str, int, int], Awaitable[Tuple[asyncio.StreamReader, asyncio.StreamWriter]]]


class SafeProxy:
    def __init__(
        self,
        allowed_domains: Sequence[str],
        resolver: Optional[Callable[..., object]] = None,
        connector: Optional[Connector] = None,
        connect_timeout_seconds: float = 5.0,
    ) -> None:
        self.allowed_domains = normalize_domains(allowed_domains)
        self.resolver = resolver
        self.connector = connector or self._connect_pinned_ip
        self.connect_timeout_seconds = connect_timeout_seconds
        self.server: Optional[asyncio.AbstractServer] = None
        self.port: Optional[int] = None
        self.blocked_requests = 0
        self.last_block_reason: Optional[str] = None
        self._active_tasks = set()

    async def start(self) -> int:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0, limit=16 * 1024)
        self.port = int(self.server.sockets[0].getsockname()[1])
        return self.port

    async def close(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
            self.server = None
        tasks = list(self._active_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    @staticmethod
    async def _connect_pinned_ip(address: str, port: int, family: int):
        return await asyncio.wait_for(
            asyncio.open_connection(address, port, family=family),
            timeout=5.0,
        )

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        current = asyncio.current_task()
        if current is not None:
            self._active_tasks.add(current)
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            if not request_line or len(request_line) > 8192:
                await self._reply(writer, 400, "Invalid proxy request")
                return
            try:
                method, authority, _version = request_line.decode("ascii").strip().split(" ", 2)
            except (UnicodeDecodeError, ValueError):
                await self._reply(writer, 400, "Invalid proxy request")
                return

            # The renderer only accepts HTTPS URLs. Browser HTTPS requests use CONNECT;
            # plain HTTP and non-CONNECT methods are deliberately denied.
            if method.upper() != "CONNECT":
                self._block("non_https_proxy_request")
                await self._reply(writer, 403, "Only validated HTTPS destinations are allowed")
                return
            try:
                hostname, port = self._parse_authority(authority)
            except ValueError:
                self._block("invalid_connect_authority")
                await self._reply(writer, 400, "Invalid CONNECT destination")
                return
            await self._read_headers(reader)
            try:
                addresses = await validate_proxy_target(
                    hostname,
                    port,
                    self.allowed_domains,
                    resolver=self.resolver,
                )
            except URLPolicyError as exc:
                reason = str(exc)
                self._block(reason)
                logger.info("proxy destination rejected: host=%s reason=%s", hostname[:253], reason[:80])
                await self._reply(writer, 403, "Destination rejected by network policy")
                return

            # Connect to a numeric address from the validated DNS answer. No hostname is
            # handed to the transport, so a second DNS lookup cannot rebind the socket.
            address, family = addresses[0]
            try:
                upstream_reader, upstream_writer = await asyncio.wait_for(
                    self.connector(address, port, family), timeout=self.connect_timeout_seconds
                )
            except Exception:
                logger.info("proxy connection failed: host=%s", hostname[:253])
                await self._reply(writer, 502, "Validated destination is unavailable")
                return

            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            await self._relay(reader, writer, upstream_reader, upstream_writer)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError, ValueError):
            pass
        finally:
            if current is not None:
                self._active_tasks.discard(current)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    @staticmethod
    def _parse_authority(authority: str) -> Tuple[str, int]:
        if "@" in authority or not authority:
            raise ValueError("Invalid CONNECT authority")
        if authority.startswith("["):
            closing = authority.find("]")
            if closing < 0 or authority[closing + 1:closing + 2] != ":":
                raise ValueError("Invalid CONNECT authority")
            hostname = authority[1:closing]
            port_text = authority[closing + 2:]
        else:
            if authority.count(":") != 1:
                raise ValueError("Invalid CONNECT authority")
            hostname, port_text = authority.rsplit(":", 1)
        if not port_text.isdigit():
            raise ValueError("Invalid CONNECT port")
        port = int(port_text)
        if not hostname or port < 1 or port > 65535:
            raise ValueError("Invalid CONNECT authority")
        return hostname.rstrip(".").lower(), port

    @staticmethod
    async def _read_headers(reader: asyncio.StreamReader) -> None:
        total = 0
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            total += len(line)
            if not line or total > 16 * 1024:
                raise ValueError("Invalid proxy headers")
            if line in (b"\r\n", b"\n"):
                return

    def _block(self, reason: str) -> None:
        self.blocked_requests += 1
        self.last_block_reason = reason[:80]

    @staticmethod
    async def _reply(writer: asyncio.StreamWriter, status: int, message: str) -> None:
        body = message.encode("utf-8")
        writer.write(
            ("HTTP/1.1 %d %s\r\n" % (status, "Forbidden" if status == 403 else "Bad Gateway" if status == 502 else "Bad Request"))
            .encode("ascii")
            + b"Content-Type: text/plain; charset=utf-8\r\n"
            + ("Content-Length: %d\r\n" % len(body)).encode("ascii")
            + b"Connection: close\r\n\r\n"
            + body
        )
        await writer.drain()

    @staticmethod
    async def _pipe(source: asyncio.StreamReader, destination: asyncio.StreamWriter) -> None:
        try:
            while True:
                data = await source.read(64 * 1024)
                if not data:
                    break
                destination.write(data)
                await destination.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            try:
                destination.write_eof()
            except (AttributeError, ConnectionError, OSError):
                pass

    async def _relay(
        self,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
        upstream_reader: asyncio.StreamReader,
        upstream_writer: asyncio.StreamWriter,
    ) -> None:
        tasks = [
            asyncio.create_task(self._pipe(client_reader, upstream_writer)),
            asyncio.create_task(self._pipe(upstream_reader, client_writer)),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            upstream_writer.close()
            try:
                await upstream_writer.wait_closed()
            except Exception:
                pass

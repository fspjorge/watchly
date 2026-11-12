import asyncio
import socket

from safe_proxy import SafeProxy
from security import normalize_domains, validate_target_url


def run(coro):
    return asyncio.run(coro)


def test_proxy_connect_uses_numeric_prevalidated_ip():
    async def scenario():
        connected = []
        resolver_calls = []

        async def origin(_reader, writer):
            writer.close()
            await writer.wait_closed()

        origin_server = await asyncio.start_server(origin, "127.0.0.1", 0)
        origin_port = origin_server.sockets[0].getsockname()[1]

        def resolver(host, port):
            resolver_calls.append((host, port))
            return ["1.1.1.1"]

        async def connector(ip, port, family):
            connected.append((ip, port, family))
            return await asyncio.open_connection("127.0.0.1", origin_port)

        proxy = SafeProxy(["worten.pt"], resolver=resolver, connector=connector)
        proxy_port = await proxy.start()
        try:
            # Model API validation followed by Chromium's CONNECT. The proxy itself
            # resolves again immediately before the fixed-IP connector is called.
            target = await validate_target_url("https://www.worten.pt/product", ["worten.pt"], resolver)
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
            writer.write(b"CONNECT www.worten.pt:443 HTTP/1.1\r\nHost: www.worten.pt:443\r\n\r\n")
            await writer.drain()
            response = await reader.readline()
            assert response.startswith(b"HTTP/1.1 200")
            await reader.read()
            writer.close()
            await writer.wait_closed()
            assert target.addresses == (("1.1.1.1", socket.AF_INET),)
            assert resolver_calls == [("www.worten.pt", 443), ("www.worten.pt", 443)]
            assert connected == [("1.1.1.1", 443, socket.AF_INET)]
        finally:
            await proxy.close()
            origin_server.close()
            await origin_server.wait_closed()

    run(scenario())


def test_dns_rebinding_to_loopback_is_rejected_before_connector():
    async def scenario():
        calls = []
        connections = []

        def resolver(host, port):
            calls.append((host, port))
            return ["1.1.1.1"] if len(calls) == 1 else ["127.0.0.1"]

        async def connector(ip, port, family):
            connections.append((ip, port, family))
            raise AssertionError("connector must not receive the rebound private IP")

        proxy = SafeProxy(["worten.pt"], resolver=resolver, connector=connector)
        proxy_port = await proxy.start()
        try:
            initial = await validate_target_url("https://www.worten.pt/", ["worten.pt"], resolver)
            reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
            writer.write(b"CONNECT www.worten.pt:443 HTTP/1.1\r\nHost: www.worten.pt:443\r\n\r\n")
            await writer.drain()
            response = await reader.read()
            writer.close()
            await writer.wait_closed()
            assert initial.addresses == (("1.1.1.1", socket.AF_INET),)
            assert len(calls) == 2
            assert response.startswith(b"HTTP/1.1 403")
            assert connections == []
            assert proxy.blocked_requests == 1
        finally:
            await proxy.close()

    run(scenario())


def test_each_redirect_host_gets_an_independent_validated_connection():
    async def scenario():
        destinations = []
        addresses = {"www.worten.pt": "1.1.1.1", "cdn.worten.pt": "1.0.0.1"}

        async def origin(_reader, writer):
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(origin, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]

        def resolver(host, _port):
            return [addresses[host]]

        async def connector(ip, target_port, family):
            destinations.append((ip, target_port, family))
            return await asyncio.open_connection("127.0.0.1", port)

        proxy = SafeProxy(["worten.pt"], resolver=resolver, connector=connector)
        proxy_port = await proxy.start()
        try:
            for host in ("www.worten.pt", "cdn.worten.pt"):
                reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
                writer.write(("CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n" % (host, host)).encode("ascii"))
                await writer.drain()
                assert (await reader.readline()).startswith(b"HTTP/1.1 200")
                await reader.read()
                writer.close()
                await writer.wait_closed()
            assert destinations == [
                ("1.1.1.1", 443, socket.AF_INET),
                ("1.0.0.1", 443, socket.AF_INET),
            ]
        finally:
            await proxy.close()
            server.close()
            await server.wait_closed()

    run(scenario())

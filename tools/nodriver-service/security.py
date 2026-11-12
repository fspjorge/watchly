"""URL policy for the render service. All HTTP browser traffic uses SafeProxy."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence, Tuple
from urllib.parse import SplitResult, urlsplit, urlunsplit


class URLPolicyError(ValueError):
    """The requested URL is not permitted by the service policy."""


@dataclass(frozen=True)
class ValidatedTarget:
    url: str
    hostname: str
    port: int
    addresses: Tuple[Tuple[str, int], ...]


def normalize_domains(domains: Sequence[str]) -> Tuple[str, ...]:
    normalized = []
    for item in domains:
        value = item.strip().rstrip(".").lower()
        if not value or "/" in value or ":" in value or "@" in value:
            continue
        try:
            value = value.encode("idna").decode("ascii")
        except UnicodeError:
            continue
        if value and value not in normalized:
            normalized.append(value)
    return tuple(normalized)


def host_is_allowed(hostname: str, allowed_domains: Sequence[str]) -> bool:
    host = hostname.rstrip(".").lower()
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return False
    return any(host == domain or host.endswith("." + domain) for domain in allowed_domains)


def _parse_https_url(value: str, allowed_domains: Sequence[str]) -> Tuple[SplitResult, str, int]:
    if not isinstance(value, str) or len(value) > 2048:
        raise URLPolicyError("URL inválido ou demasiado longo.")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port or 443
    except ValueError as exc:
        raise URLPolicyError("URL inválido.") from exc
    if parsed.scheme.lower() != "https" or not hostname or parsed.username or parsed.password:
        raise URLPolicyError("Só são permitidos URLs HTTPS sem credenciais embutidas.")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise URLPolicyError("URLs com endereço IP literal não são permitidos.")
    if port != 443:
        raise URLPolicyError("Só é permitida a porta HTTPS 443.")
    if not host_is_allowed(hostname, allowed_domains):
        raise URLPolicyError("O domínio não está autorizado para este serviço.")
    return parsed, hostname.rstrip(".").lower(), port


def _records_to_public_addresses(records: Sequence[object]) -> Tuple[Tuple[str, int], ...]:
    addresses = []
    for record in records:
        if isinstance(record, str):
            raw_address, family = record, socket.AF_INET6 if ":" in record else socket.AF_INET
        else:
            try:
                family, _socktype, _proto, _canonname, sockaddr = record  # type: ignore[misc]
                raw_address = sockaddr[0]
            except (TypeError, ValueError, IndexError) as exc:
                raise URLPolicyError("A resolução DNS devolveu uma resposta inválida.") from exc
        try:
            address = ipaddress.ip_address(raw_address)
        except ValueError as exc:
            raise URLPolicyError("A resolução DNS devolveu um endereço inválido.") from exc
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            address = address.ipv4_mapped
            family = socket.AF_INET
        # Python versions before 3.13 classify multicast ranges as globally
        # scoped in some cases. Public routability is stricter than `is_global`.
        if (
            not address.is_global
            or address.is_multicast
            or address.is_unspecified
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_private
        ):
            raise URLPolicyError("O domínio resolve para um endereço de rede não público.")
        pair = (str(address), family)
        if pair not in addresses:
            addresses.append(pair)
    if not addresses:
        raise URLPolicyError("O domínio não tem endereços DNS utilizáveis.")
    return tuple(addresses)


async def resolve_public_addresses(
    hostname: str,
    port: int,
    resolver: Optional[Callable[..., object]] = None,
    timeout_seconds: float = 5.0,
) -> Tuple[Tuple[str, int], ...]:
    """Resolve every A/AAAA answer and rejects the entire set if any is non-public."""
    try:
        if resolver is None:
            loop = asyncio.get_running_loop()
            records = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: socket.getaddrinfo(hostname, port, 0, socket.SOCK_STREAM),
                ),
                timeout=timeout_seconds,
            )
        else:
            result = resolver(hostname, port)
            if asyncio.iscoroutine(result):
                records = await asyncio.wait_for(result, timeout=timeout_seconds)
            else:
                records = result
    except URLPolicyError:
        raise
    except Exception as exc:
        raise URLPolicyError("Não foi possível resolver o domínio.") from exc
    return _records_to_public_addresses(records)  # type: ignore[arg-type]


async def validate_target_url(
    value: str,
    allowed_domains: Sequence[str],
    resolver: Optional[Callable[..., object]] = None,
) -> ValidatedTarget:
    parsed, hostname, port = _parse_https_url(value, allowed_domains)
    addresses = await resolve_public_addresses(hostname, port, resolver=resolver)
    normalized = urlunsplit(("https", parsed.netloc, parsed.path or "/", parsed.query, ""))
    return ValidatedTarget(normalized, hostname, port, addresses)


async def validate_proxy_target(
    hostname: str,
    port: int,
    allowed_domains: Sequence[str],
    resolver: Optional[Callable[..., object]] = None,
) -> Tuple[Tuple[str, int], ...]:
    """Validate each HTTP CONNECT destination immediately before its TCP connection."""
    try:
        ipaddress.ip_address(hostname.strip("[]"))
    except ValueError:
        pass
    else:
        raise URLPolicyError("Ligações para endereços IP literais não são permitidas.")
    if port != 443 or not host_is_allowed(hostname, allowed_domains):
        raise URLPolicyError("O destino da ligação não está autorizado.")
    return await resolve_public_addresses(hostname, port, resolver=resolver)

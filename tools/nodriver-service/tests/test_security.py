import asyncio
import socket

import pytest

from security import URLPolicyError, normalize_domains, validate_proxy_target, validate_target_url


ALLOWED = normalize_domains(["worten.pt"])


def public_answers(_host, _port):
    return ["1.1.1.1", "2606:4700:4700::1111"]


def test_accepts_allowlisted_public_ipv4_and_ipv6_answers():
    result = asyncio.run(validate_target_url("https://www.worten.pt/item", ALLOWED, public_answers))
    assert result.hostname == "www.worten.pt"
    assert result.port == 443
    assert result.addresses == (("1.1.1.1", socket.AF_INET), ("2606:4700:4700::1111", socket.AF_INET6))


@pytest.mark.parametrize("address", [
    "10.0.0.1", "172.16.0.1", "192.168.1.2", "127.0.0.1", "169.254.169.254",
    "0.0.0.0", "224.0.0.1", "100.64.0.1", "240.0.0.1", "::", "::1",
    "fe80::1", "fc00::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1",
])
def test_rejects_non_public_or_mapped_private_dns_answers(address):
    with pytest.raises(URLPolicyError):
        asyncio.run(validate_target_url("https://www.worten.pt/", ALLOWED, lambda _h, _p: [address]))


def test_rejects_mixed_public_and_private_dns_answers():
    with pytest.raises(URLPolicyError):
        asyncio.run(validate_target_url(
            "https://www.worten.pt/", ALLOWED, lambda _h, _p: ["1.1.1.1", "10.0.0.2"]
        ))


@pytest.mark.parametrize("url", [
    "http://www.worten.pt/", "https://127.0.0.1/", "https://[::1]/",
    "https://localhost/", "https://metadata.google.internal/", "file:///etc/passwd",
    "https://user:pass@www.worten.pt/", "https://www.worten.pt:8443/",
    "https://worten.pt.attacker.example/",
])
def test_rejects_unsafe_url_forms_and_unapproved_hosts(url):
    with pytest.raises(URLPolicyError):
        asyncio.run(validate_target_url(url, ALLOWED, public_answers))


def test_dns_errors_are_rejected():
    with pytest.raises(URLPolicyError, match="resolver"):
        asyncio.run(validate_target_url("https://www.worten.pt/", ALLOWED, lambda _h, _p: (_ for _ in ()).throw(OSError())))


def test_redirect_destination_uses_same_allowlist_and_public_ip_policy():
    assert asyncio.run(validate_proxy_target("cdn.worten.pt", 443, ALLOWED, public_answers))
    for host in ("localhost", "127.0.0.1", "[::1]", "outside.example"):
        with pytest.raises(URLPolicyError):
            asyncio.run(validate_proxy_target(host, 443, ALLOWED, public_answers))

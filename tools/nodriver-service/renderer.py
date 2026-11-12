"""Render an authorized HTTPS page in a disposable Chromium profile."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass
from typing import Optional

from safe_proxy import SafeProxy
from security import ValidatedTarget

logger = logging.getLogger("nodriver_service.renderer")


class BrowserRenderError(RuntimeError):
    pass


class RenderedContentTooLarge(RuntimeError):
    pass


@dataclass(frozen=True)
class RenderResult:
    status: str
    blocked_reason: Optional[str]
    title: str
    final_url: str
    html: str
    text: str
    content_bytes: int
    http_status: Optional[int]
    proxy_blocked_requests: int
    duration_ms: int


CHALLENGE_MARKERS = (
    "just a moment",
    "checking your browser",
    "verify you are human",
    "security verification",
    "attention required! | cloudflare",
    "cf-chl-",
    "captcha",
    "complete the security check",
)


def detect_challenge(title: str, visible_text: str, html: str) -> Optional[str]:
    sample = "\n".join((title, visible_text[:12000], html[:12000])).lower()
    if any(marker in sample for marker in CHALLENGE_MARKERS):
        return "challenge"
    return None


def _utf8_size(value: str) -> int:
    return len(value.encode("utf-8"))


async def render_page(target: ValidatedTarget, config) -> RenderResult:
    started = asyncio.get_running_loop().time()
    proxy = SafeProxy(config.allowed_domains)
    proxy_port = await proxy.start()
    profile = tempfile.mkdtemp(prefix="watchly-render-")
    browser = None
    phase = "browser_start"
    try:
        # Import lazily so policy/API tests can run without installing Chromium or nodriver.
        import nodriver

        browser_args = [
            "--proxy-server=http://127.0.0.1:%d" % proxy_port,
            # Remove Chromium's implicit loopback proxy bypass. All HTTP(S) sockets from
            # the page must be evaluated by SafeProxy before a destination is connected.
            "--proxy-bypass-list=<-loopback>",
            "--host-resolver-rules=MAP * ~NOTFOUND",
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--disable-background-networking",
            "--disable-component-update",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        browser_executable = os.getenv("CHROME_BIN") or None
        # Keep local rendering headful by default. Containers opt into Chromium's
        # supported headless mode so they do not need an X server or Xvfb.
        headless = os.getenv("BROWSER_HEADLESS", "").strip().lower() == "true"
        # No expert mode, CAPTCHA helpers, stealth flags, or custom user-agent are used.
        logger.info("render event=browser_start_begin host=%s headless=%s", target.hostname, headless)
        browser = await asyncio.wait_for(
            nodriver.start(
                headless=headless,
                user_data_dir=profile,
                browser_executable_path=browser_executable,
                browser_args=browser_args,
                sandbox=True,
                expert=False,
            ),
            timeout=config.browser_start_timeout_seconds,
        )
        logger.info("render event=browser_started host=%s", target.hostname)

        phase = "navigation"
        logger.info("render event=navigation_begin host=%s", target.hostname)
        tab = await asyncio.wait_for(browser.get(target.url), timeout=config.navigation_timeout_seconds)
        logger.info("render event=navigation_completed host=%s", target.hostname)
        await asyncio.wait_for(tab.sleep(config.settle_seconds), timeout=config.settle_seconds + 2)

        phase = "content_evaluation"
        values = await asyncio.wait_for(
            tab.evaluate(
                "({title: document.title || '', url: location.href, text: document.body ? document.body.innerText : '', "
                "status: (performance.getEntriesByType('navigation')[0] || {}).responseStatus || null})",
                return_by_value=True,
            ),
            timeout=5.0,
        )
        phase = "content_read"
        html = await asyncio.wait_for(tab.get_content(), timeout=5.0)
        if not isinstance(values, dict) or not isinstance(html, str):
            raise BrowserRenderError("O navegador devolveu um resultado inválido.")

        text = values.get("text") if isinstance(values.get("text"), str) else ""
        content_bytes = _utf8_size(html) + _utf8_size(text)
        if content_bytes > config.max_content_bytes:
            raise RenderedContentTooLarge("A página renderizada excede o limite de conteúdo configurado.")

        challenge = detect_challenge(str(values.get("title") or ""), text, html)
        response_status = values.get("status") if isinstance(values.get("status"), int) else None
        if challenge:
            status, reason = "blocked", "challenge"
        elif response_status in (403, 429):
            status, reason = "blocked", "origin_http_%d" % response_status
        elif proxy.blocked_requests:
            status, reason = "blocked", "network_policy"
        else:
            status, reason = "rendered", None

        return RenderResult(
            status=status,
            blocked_reason=reason,
            title=str(values.get("title") or "")[:500],
            final_url=str(values.get("url") or target.url)[:2048],
            html=html,
            text=text,
            content_bytes=content_bytes,
            http_status=response_status,
            proxy_blocked_requests=proxy.blocked_requests,
            duration_ms=int((asyncio.get_running_loop().time() - started) * 1000),
        )
    except asyncio.CancelledError:
        cancellation_code = {
            "browser_start": "BROWSER_START_CANCELLED",
            "navigation": "NAVIGATION_CANCELLED",
            "content_evaluation": "CONTENT_EVALUATION_CANCELLED",
            "content_read": "CONTENT_READ_CANCELLED",
        }.get(phase, "RENDER_CANCELLED")
        logger.warning(
            "render event=phase_cancelled host=%s phase=%s error_type=CancelledError error_code=%s",
            target.hostname,
            phase,
            cancellation_code,
        )
        raise
    except RenderedContentTooLarge:
        raise
    except Exception as exc:
        if isinstance(exc, asyncio.TimeoutError):
            error_code = {
                "browser_start": "BROWSER_START_TIMEOUT",
                "navigation": "NAVIGATION_TIMEOUT",
                "content_evaluation": "CONTENT_EVALUATION_TIMEOUT",
                "content_read": "CONTENT_READ_TIMEOUT",
            }.get(phase, "RENDER_TIMEOUT")
        else:
            error_code = {
                "browser_start": "BROWSER_START_FAILED",
                "navigation": "NAVIGATION_FAILED",
                "content_evaluation": "CONTENT_EVALUATION_FAILED",
                "content_read": "CONTENT_READ_FAILED",
            }.get(phase, "RENDER_FAILED")
        logger.warning(
            "render event=phase_failed host=%s phase=%s error_type=%s error_code=%s",
            target.hostname,
            phase,
            type(exc).__name__,
            error_code,
        )
        if proxy.blocked_requests:
            return RenderResult(
                status="blocked",
                blocked_reason="network_policy",
                title="",
                final_url=target.url,
                html="",
                text="",
                content_bytes=0,
                http_status=None,
                proxy_blocked_requests=proxy.blocked_requests,
                duration_ms=int((asyncio.get_running_loop().time() - started) * 1000),
            )
        logger.info("render failed for host=%s error=%s", target.hostname, type(exc).__name__)
        raise BrowserRenderError("Não foi possível renderizar a página.") from exc
    finally:
        if browser is not None:
            try:
                browser.stop()
            except Exception:
                logger.warning("chromium shutdown failed")
        await proxy.close()
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: shutil.rmtree(profile, True))

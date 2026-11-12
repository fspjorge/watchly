"""Standalone authenticated render API for pages that require JavaScript."""

from __future__ import annotations

import asyncio
import hmac
import logging
import os
import time
from dataclasses import dataclass
from typing import Callable, Optional, Tuple

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from renderer import BrowserRenderError, RenderedContentTooLarge, RenderResult, render_page
from security import URLPolicyError, normalize_domains, validate_target_url

logger = logging.getLogger("nodriver_service")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    logger.addHandler(handler)


@dataclass(frozen=True)
class Settings:
    api_token: str
    allowed_domains: Tuple[str, ...]
    render_timeout_seconds: float = 45.0
    browser_start_timeout_seconds: float = 15.0
    navigation_timeout_seconds: float = 25.0
    settle_seconds: float = 2.0
    max_content_bytes: int = 2 * 1024 * 1024

    @classmethod
    def from_env(cls) -> "Settings":
        token = os.getenv("RENDER_API_TOKEN", "")
        domains = normalize_domains(os.getenv("ALLOWED_DOMAINS", "worten.pt").split(","))
        return cls(
            api_token=token,
            allowed_domains=domains,
            render_timeout_seconds=_positive_float("RENDER_TIMEOUT_SECONDS", 45.0, 5.0, 120.0),
            browser_start_timeout_seconds=_positive_float("BROWSER_START_TIMEOUT_SECONDS", 15.0, 1.0, 45.0),
            navigation_timeout_seconds=_positive_float("NAVIGATION_TIMEOUT_SECONDS", 25.0, 1.0, 60.0),
            settle_seconds=_positive_float("SETTLE_SECONDS", 2.0, 0.0, 10.0),
            max_content_bytes=_positive_int("MAX_CONTENT_BYTES", 2 * 1024 * 1024, 16 * 1024, 8 * 1024 * 1024),
        )


def _positive_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if minimum <= value <= maximum else default


def _positive_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return value if minimum <= value <= maximum else default


class RenderRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=2048)


def _result_body(result: RenderResult) -> dict:
    return {
        "status": result.status,
        "blocked_reason": result.blocked_reason,
        "title": result.title,
        "final_url": result.final_url,
        "html": result.html,
        "text": result.text,
        "content_bytes": result.content_bytes,
        "http_status": result.http_status,
        "metrics": {
            "duration_ms": result.duration_ms,
            "proxy_blocked_requests": result.proxy_blocked_requests,
        },
    }


def create_app(
    settings: Optional[Settings] = None,
    renderer: Optional[Callable[[object, Settings], object]] = None,
    resolver: Optional[Callable[..., object]] = None,
) -> FastAPI:
    config = settings or Settings.from_env()
    render = renderer or render_page
    application = FastAPI(title="Watchly JavaScript Renderer", version="0.1.0")

    @application.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, _exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"status": "error", "error": "INVALID_REQUEST"})

    @application.middleware("http")
    async def limit_request_body(request: Request, call_next):
        length = request.headers.get("content-length")
        if length:
            try:
                if int(length) > 16 * 1024:
                    return JSONResponse(status_code=413, content={"status": "error", "error": "REQUEST_TOO_LARGE"})
            except ValueError:
                return JSONResponse(status_code=400, content={"status": "error", "error": "INVALID_CONTENT_LENGTH"})
        return await call_next(request)

    @application.get("/health")
    async def health():
        return {"status": "ok"}

    @application.post("/render")
    async def render_endpoint(body: RenderRequest, authorization: Optional[str] = Header(default=None)):
        if not config.api_token:
            raise HTTPException(status_code=503, detail={"status": "error", "error": "SERVICE_NOT_CONFIGURED"})
        supplied = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
        try:
            matches = hmac.compare_digest(supplied.encode("utf-8"), config.api_token.encode("utf-8"))
        except (UnicodeEncodeError, TypeError):
            matches = False
        if not matches:
            raise HTTPException(status_code=401, detail={"status": "error", "error": "UNAUTHORIZED"})
        if not config.allowed_domains:
            raise HTTPException(status_code=503, detail={"status": "error", "error": "NO_ALLOWED_DOMAINS"})

        started = time.monotonic()
        try:
            target = await validate_target_url(body.url, config.allowed_domains, resolver=resolver)
        except URLPolicyError as exc:
            raise HTTPException(status_code=403, detail={"status": "error", "error": "URL_REJECTED", "message": str(exc)})

        try:
            result = await asyncio.wait_for(render(target, config), timeout=config.render_timeout_seconds)
        except asyncio.TimeoutError:
            logger.info("render timed out: host=%s", target.hostname)
            raise HTTPException(status_code=504, detail={"status": "error", "error": "RENDER_TIMEOUT"})
        except RenderedContentTooLarge:
            raise HTTPException(status_code=413, detail={"status": "error", "error": "CONTENT_TOO_LARGE"})
        except BrowserRenderError:
            raise HTTPException(status_code=502, detail={"status": "error", "error": "BROWSER_RENDER_FAILED"})
        except Exception as exc:
            logger.error("render failed: host=%s type=%s", target.hostname, type(exc).__name__)
            raise HTTPException(status_code=502, detail={"status": "error", "error": "RENDER_FAILED"})

        # The renderer owns the result schema; validate size again at the HTTP boundary.
        if not isinstance(result, RenderResult):
            raise HTTPException(status_code=502, detail={"status": "error", "error": "INVALID_RENDER_RESULT"})
        if result.content_bytes > config.max_content_bytes:
            raise HTTPException(status_code=413, detail={"status": "error", "error": "CONTENT_TOO_LARGE"})
        logger.info(
            "render completed: host=%s status=%s blocked_reason=%s bytes=%d duration_ms=%d",
            target.hostname,
            result.status,
            result.blocked_reason or "none",
            result.content_bytes,
            int((time.monotonic() - started) * 1000),
        )
        return _result_body(result)

    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=_positive_int("PORT", 8080, 1, 65535), access_log=False)

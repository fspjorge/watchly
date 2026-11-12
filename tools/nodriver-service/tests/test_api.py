import asyncio

from fastapi.testclient import TestClient

from app import Settings, create_app
from renderer import BrowserRenderError, RenderResult


TOKEN = "test-render-token-not-for-production"


def settings(**overrides):
    values = {
        "api_token": TOKEN,
        "allowed_domains": ("worten.pt",),
        "render_timeout_seconds": 0.02,
        "browser_start_timeout_seconds": 1.0,
        "navigation_timeout_seconds": 1.0,
        "settle_seconds": 0.0,
        "max_content_bytes": 1024 * 1024,
    }
    values.update(overrides)
    return Settings(**values)


def public_resolver(_host, _port):
    return ["1.1.1.1"]


def fake_result(status="rendered", blocked_reason=None):
    return RenderResult(
        status=status,
        blocked_reason=blocked_reason,
        title="Product page",
        final_url="https://www.worten.pt/item",
        html="<html><title>Product page</title><body>Product</body></html>",
        text="Product",
        content_bytes=60,
        http_status=200,
        proxy_blocked_requests=0,
        duration_ms=19,
    )


def test_health_does_not_need_browser_or_token():
    with TestClient(create_app(settings(api_token=""))) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_render_requires_bearer_token_before_resolution_or_browser():
    calls = []
    app = create_app(settings(), renderer=lambda *_: calls.append("render"), resolver=lambda *_: calls.append("dns"))
    with TestClient(app) as client:
        response = client.post("/render", json={"url": "https://www.worten.pt/item"})
    assert response.status_code == 401
    assert calls == []


def test_render_returns_html_title_final_url_and_metrics():
    async def fake_renderer(*_):
        return fake_result()

    app = create_app(settings(), renderer=fake_renderer, resolver=public_resolver)
    with TestClient(app) as client:
        response = client.post(
            "/render", headers={"Authorization": "Bearer " + TOKEN}, json={"url": "https://www.worten.pt/item"}
        )
    assert response.status_code == 200
    assert response.json()["status"] == "rendered"
    assert response.json()["title"] == "Product page"
    assert response.json()["final_url"] == "https://www.worten.pt/item"
    assert "<body>Product</body>" in response.json()["html"]
    assert response.json()["metrics"] == {"duration_ms": 19, "proxy_blocked_requests": 0}
    assert TOKEN not in response.text


def test_rejected_domains_do_not_invoke_renderer():
    calls = []
    app = create_app(settings(), renderer=lambda *_: calls.append(1), resolver=public_resolver)
    with TestClient(app) as client:
        response = client.post(
            "/render", headers={"Authorization": "Bearer " + TOKEN}, json={"url": "https://attacker.example/"}
        )
    assert response.status_code == 403
    assert response.json()["detail"]["error"] == "URL_REJECTED"
    assert calls == []


def test_missing_server_token_disables_render_endpoint():
    app = create_app(settings(api_token=""), renderer=lambda *_: fake_result(), resolver=public_resolver)
    with TestClient(app) as client:
        response = client.post(
            "/render", headers={"Authorization": "Bearer " + TOKEN}, json={"url": "https://www.worten.pt/"}
        )
    assert response.status_code == 503


def test_render_timeout_is_structured():
    async def slow_renderer(*_):
        await asyncio.sleep(0.2)

    app = create_app(settings(render_timeout_seconds=0.01), renderer=slow_renderer, resolver=public_resolver)
    with TestClient(app) as client:
        response = client.post(
            "/render", headers={"Authorization": "Bearer " + TOKEN}, json={"url": "https://www.worten.pt/"}
        )
    assert response.status_code == 504
    assert response.json()["detail"]["error"] == "RENDER_TIMEOUT"


def test_browser_render_failure_preserves_structured_error_contract():
    def failed_renderer(*_args):
        raise BrowserRenderError("internal browser failure")

    app = create_app(settings(), renderer=failed_renderer, resolver=public_resolver)
    with TestClient(app) as client:
        response = client.post(
            "/render", headers={"Authorization": "Bearer " + TOKEN}, json={"url": "https://www.worten.pt/item"}
        )

    assert response.status_code == 502
    assert response.json() == {"detail": {"status": "error", "error": "BROWSER_RENDER_FAILED"}}
    assert TOKEN not in response.text


def test_bad_json_and_missing_url_are_structured():
    with TestClient(create_app(settings(), resolver=public_resolver)) as client:
        missing = client.post("/render", headers={"Authorization": "Bearer " + TOKEN}, json={})
        malformed = client.post(
            "/render", headers={"Authorization": "Bearer " + TOKEN, "content-type": "application/json"}, content="{"
        )
    assert missing.status_code == 422
    assert missing.json() == {"status": "error", "error": "INVALID_REQUEST"}
    assert malformed.status_code == 422
    assert malformed.json() == {"status": "error", "error": "INVALID_REQUEST"}

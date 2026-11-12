import asyncio
import logging
import os
import sys
import types

import pytest

import renderer
from app import Settings
from renderer import BrowserRenderError, RenderedContentTooLarge, detect_challenge
from security import ValidatedTarget


class FakeProxy:
    instance = None

    def __init__(self, allowed_domains):
        self.allowed_domains = allowed_domains
        self.blocked_requests = 0
        self.last_block_reason = None
        self.closed = False
        FakeProxy.instance = self

    async def start(self):
        return 43123

    async def close(self):
        self.closed = True


class FakeTab:
    def __init__(self, values, html, wait=False):
        self.values = values
        self.html = html
        self.wait = wait

    async def sleep(self, _seconds):
        return None

    async def evaluate(self, *_args, **_kwargs):
        return self.values

    async def get_content(self):
        return self.html


class FakeBrowser:
    def __init__(self, tab):
        self.tab = tab
        self.stopped = False

    async def get(self, _url):
        if self.tab.wait:
            await asyncio.sleep(10)
        return self.tab

    def stop(self):
        self.stopped = True


def install_fake_nodriver(monkeypatch, tab):
    browser = FakeBrowser(tab)
    calls = {}

    async def start(**kwargs):
        calls.update(kwargs)
        return browser

    monkeypatch.setitem(sys.modules, "nodriver", types.SimpleNamespace(start=start))
    return browser, calls


def target():
    return ValidatedTarget("https://www.worten.pt/item", "www.worten.pt", 443, (("1.1.1.1", 2),))


def config(max_content_bytes=1024 * 1024):
    return Settings(
        api_token="local-test-token",
        allowed_domains=("worten.pt",),
        render_timeout_seconds=1,
        browser_start_timeout_seconds=1,
        navigation_timeout_seconds=1,
        settle_seconds=0,
        max_content_bytes=max_content_bytes,
    )


def test_challenge_detection_labels_challenge_without_solving_it():
    assert detect_challenge("Just a moment...", "", "") == "challenge"
    assert detect_challenge("Product", "Coffee machine", "<html>normal page</html>") is None


def test_render_extracts_title_url_html_and_visible_text_and_stops_browser(monkeypatch, caplog):
    tab = FakeTab(
        {"title": "Coffee machine", "url": "https://www.worten.pt/product", "text": "Price 99 EUR", "status": 200},
        "<html><title>Coffee machine</title><body>Price 99 EUR</body></html>",
    )
    browser, calls = install_fake_nodriver(monkeypatch, tab)
    monkeypatch.setattr(renderer, "SafeProxy", FakeProxy)
    caplog.set_level(logging.INFO, logger="nodriver_service")

    result = asyncio.run(renderer.render_page(target(), config()))

    assert result.status == "rendered"
    assert result.title == "Coffee machine"
    assert result.final_url == "https://www.worten.pt/product"
    assert result.html.endswith("</html>")
    assert result.text == "Price 99 EUR"
    assert result.http_status == 200
    assert browser.stopped is True
    assert FakeProxy.instance.closed is True
    assert calls["headless"] is False
    assert calls["expert"] is False
    assert all("user-agent" not in arg.lower() and "stealth" not in arg.lower() for arg in calls["browser_args"])
    assert not os.path.exists(calls["user_data_dir"])
    assert "event=browser_start_begin host=www.worten.pt" in caplog.text
    assert "event=browser_started host=www.worten.pt" in caplog.text
    assert "event=navigation_begin host=www.worten.pt" in caplog.text
    assert "event=navigation_completed host=www.worten.pt" in caplog.text
    assert "Coffee machine" not in caplog.text
    assert "Price 99 EUR" not in caplog.text


def test_container_headless_setting_is_passed_to_nodriver(monkeypatch):
    tab = FakeTab(
        {"title": "Example", "url": "https://www.worten.pt/product", "text": "Content", "status": 200},
        "<html><title>Example</title><body>Content</body></html>",
    )
    _browser, calls = install_fake_nodriver(monkeypatch, tab)
    monkeypatch.setattr(renderer, "SafeProxy", FakeProxy)
    monkeypatch.setenv("BROWSER_HEADLESS", "true")

    result = asyncio.run(renderer.render_page(target(), config()))

    assert result.status == "rendered"
    assert calls["headless"] is True
    assert calls["expert"] is False
    assert all("user-agent" not in arg.lower() and "stealth" not in arg.lower() for arg in calls["browser_args"])


def test_browser_start_failure_log_is_phase_specific_and_sanitized(monkeypatch, caplog):
    monkeypatch.setattr(renderer, "SafeProxy", FakeProxy)

    async def fail_start(**_kwargs):
        raise RuntimeError("private token and page html must not be logged")

    monkeypatch.setitem(sys.modules, "nodriver", types.SimpleNamespace(start=fail_start))
    with caplog.at_level(logging.INFO, logger="nodriver_service.renderer"):
        with pytest.raises(BrowserRenderError):
            asyncio.run(renderer.render_page(target(), config()))

    assert "event=browser_start_begin host=www.worten.pt" in caplog.text
    assert "event=phase_failed host=www.worten.pt phase=browser_start" in caplog.text
    assert "error_type=RuntimeError error_code=BROWSER_START_FAILED" in caplog.text
    assert "private token" not in caplog.text
    assert "page html" not in caplog.text
    assert target().url not in caplog.text


def test_navigation_failure_log_is_phase_specific_and_sanitized(monkeypatch, caplog):
    monkeypatch.setattr(renderer, "SafeProxy", FakeProxy)

    class FailingNavigationBrowser(FakeBrowser):
        async def get(self, _url):
            raise RuntimeError("private navigation detail must not be logged")

    async def start_browser(**_kwargs):
        return FailingNavigationBrowser(FakeTab({}, ""))

    monkeypatch.setitem(sys.modules, "nodriver", types.SimpleNamespace(start=start_browser))
    with caplog.at_level(logging.INFO, logger="nodriver_service.renderer"):
        with pytest.raises(BrowserRenderError):
            asyncio.run(renderer.render_page(target(), config()))

    assert "event=browser_started host=www.worten.pt" in caplog.text
    assert "event=navigation_begin host=www.worten.pt" in caplog.text
    assert "event=phase_failed host=www.worten.pt phase=navigation" in caplog.text
    assert "error_type=RuntimeError error_code=NAVIGATION_FAILED" in caplog.text
    assert "private navigation detail" not in caplog.text
    assert target().url not in caplog.text


def test_render_labels_challenge_and_does_not_attempt_to_solve(monkeypatch):
    tab = FakeTab(
        {"title": "Just a moment...", "url": "https://www.worten.pt/", "text": "Verify you are human", "status": 403},
        "<html><title>Just a moment...</title><body>Verify you are human</body></html>",
    )
    browser, _calls = install_fake_nodriver(monkeypatch, tab)
    monkeypatch.setattr(renderer, "SafeProxy", FakeProxy)
    result = asyncio.run(renderer.render_page(target(), config()))
    assert result.status == "blocked"
    assert result.blocked_reason == "challenge"
    assert browser.stopped is True


def test_render_rejects_content_above_limit_and_still_cleans_up(monkeypatch):
    tab = FakeTab({"title": "Large", "url": "https://www.worten.pt/", "text": "text", "status": 200}, "x" * 200)
    browser, _calls = install_fake_nodriver(monkeypatch, tab)
    monkeypatch.setattr(renderer, "SafeProxy", FakeProxy)
    with pytest.raises(RenderedContentTooLarge):
        asyncio.run(renderer.render_page(target(), config(max_content_bytes=100)))
    assert browser.stopped is True
    assert FakeProxy.instance.closed is True


def test_cancellation_stops_browser_closes_proxy_and_removes_profile(monkeypatch, caplog):
    tab = FakeTab({}, "", wait=True)
    browser, calls = install_fake_nodriver(monkeypatch, tab)
    monkeypatch.setattr(renderer, "SafeProxy", FakeProxy)
    caplog.set_level(logging.INFO, logger="nodriver_service")

    async def cancel_render():
        task = asyncio.create_task(renderer.render_page(target(), config()))
        await asyncio.sleep(0.03)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel_render())
    assert browser.stopped is True
    assert FakeProxy.instance.closed is True
    assert not os.path.exists(calls["user_data_dir"])
    assert "event=phase_cancelled host=www.worten.pt phase=navigation" in caplog.text
    assert "error_type=CancelledError error_code=NAVIGATION_CANCELLED" in caplog.text
    assert target().url not in caplog.text

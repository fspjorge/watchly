"""One-shot Cloud Run Job probe for sandboxed Chromium + Nodriver CDP."""

from __future__ import annotations

import asyncio
import logging
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile


class SafeNodriverHandler(logging.Handler):
    """Emit only the exception class from Nodriver's swallowed CDP retry."""

    def emit(self, record: logging.LogRecord) -> None:
        if record.getMessage() == "could not start":
            error_type = (
                record.exc_info[0].__name__
                if record.exc_info and record.exc_info[0]
                else "unavailable"
            )
            print("nodriver_cdp_last_error_type=" + error_type, flush=True)


def sandbox_failure_category(stderr: str) -> str:
    sample = stderr.lower()
    if "no usable sandbox" in sample:
        return "sandbox_unavailable"
    if "failed to move to new namespace" in sample and "operation not permitted" in sample:
        return "namespace_creation_denied"
    if "failed to move to new namespace" in sample:
        return "namespace_creation_failed"
    if "suid sandbox" in sample and (
        "not configured correctly" in sample or "needs to be owned" in sample
    ):
        return "suid_sandbox_misconfigured"
    if "error while loading shared libraries" in sample:
        return "missing_shared_library"
    if "permission denied" in sample:
        return "permission_denied"
    return "unclassified_process_exit"


def direct_chromium_probe(binary: str) -> bool:
    profile = tempfile.mkdtemp(prefix="watchly-cloudrun-direct-")
    command = [
        binary,
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--user-data-dir=" + profile,
        "--dump-dom",
        "about:blank",
    ]
    try:
        try:
            result = subprocess.run(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=20,
                check=False,
            )
        except subprocess.TimeoutExpired:
            print("direct_chromium=TIMEOUT", flush=True)
            return False
        except OSError as exc:
            print("direct_chromium=FAILED error_type=" + type(exc).__name__, flush=True)
            return False

        if result.returncode == 0:
            print("direct_chromium=PASS sandbox_enabled about_blank_only", flush=True)
            return True
        category = sandbox_failure_category(result.stderr or "")
        print(
            "direct_chromium=FAIL exit=" + str(result.returncode)
            + " category=" + category,
            flush=True,
        )
        return False
    finally:
        shutil.rmtree(profile, ignore_errors=True)


async def nodriver_probe(binary: str) -> bool:
    import nodriver

    logger = logging.getLogger("nodriver.core.browser")
    old_level = logger.level
    old_propagate = logger.propagate
    old_handlers = logger.handlers[:]
    for handler in old_handlers:
        logger.removeHandler(handler)
    safe_handler = SafeNodriverHandler()
    logger.addHandler(safe_handler)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False

    profile = tempfile.mkdtemp(prefix="watchly-cloudrun-nodriver-")
    browser = None
    try:
        browser = await asyncio.wait_for(
            nodriver.start(
                headless=True,
                user_data_dir=profile,
                browser_executable_path=binary,
                browser_args=["--disable-dev-shm-usage"],
                sandbox=True,
                expert=False,
            ),
            timeout=30,
        )
        print("nodriver_browser_start=PASS sandbox_enabled", flush=True)
        await asyncio.wait_for(browser.get("about:blank"), timeout=15)
        print("cdp_connection=PASS", flush=True)
        print("about_blank_navigation=PASS", flush=True)
        return True
    except asyncio.TimeoutError:
        print("nodriver_probe=TIMEOUT", flush=True)
        return False
    except Exception as exc:
        cause_type = type(exc.__cause__).__name__ if exc.__cause__ else "none"
        context_type = type(exc.__context__).__name__ if exc.__context__ else "none"
        print(
            "nodriver_probe=FAIL error_type=" + type(exc).__name__
            + " cause_type=" + cause_type + " context_type=" + context_type,
            flush=True,
        )
        return False
    finally:
        if browser is not None:
            try:
                await asyncio.wait_for(browser.aclose(), timeout=5)
                process = getattr(browser, "_process", None)
                if process is not None and process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
            except Exception as exc:
                print("browser_cleanup=FAIL error_type=" + type(exc).__name__, flush=True)
        logger.removeHandler(safe_handler)
        for handler in old_handlers:
            logger.addHandler(handler)
        logger.setLevel(old_level)
        logger.propagate = old_propagate
        shutil.rmtree(profile, ignore_errors=True)


async def main() -> int:
    binary = os.environ.get("CHROME_BIN") or "/usr/bin/chromium"
    path = pathlib.Path(binary)
    print("runtime_uid=" + str(os.getuid()), flush=True)
    print("chromium_path_exists=" + str(path.exists()).lower(), flush=True)
    print("chromium_executable=" + str(os.access(binary, os.X_OK)).lower(), flush=True)
    helper = pathlib.Path("/usr/lib/chromium/chrome-sandbox")
    helper_mode = helper.stat().st_mode if helper.exists() else 0
    print("setuid_helper_present=" + str(helper.exists()).lower(), flush=True)
    print("setuid_helper_bit=" + str(bool(helper_mode & stat.S_ISUID)).lower(), flush=True)

    if not path.exists() or not os.access(binary, os.X_OK):
        print("probe_result=FAIL reason=chromium_binary_unavailable", flush=True)
        return 1

    direct_ok = direct_chromium_probe(binary)
    nodriver_ok = await nodriver_probe(binary)
    if direct_ok and nodriver_ok:
        print("probe_result=PASS", flush=True)
        return 0
    print("probe_result=FAIL", flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

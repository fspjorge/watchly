#!/bin/sh
set -eu
set +x
image=watchly-nodriver-render:cloud-build-test
container=watchly-nodriver-render-$BUILD_ID
token="$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')"
if [ "${#token}" -ne 64 ]; then
  echo "FAIL: não foi possível gerar o token temporário"
  exit 1
fi
export RENDER_API_TOKEN="$token"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  unset RENDER_API_TOKEN token
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

echo "Building the local test image (no registry push)."
docker build --tag "$image" .

echo "Starting the service container for in-container smoke tests."
docker run --detach --shm-size=1g --name "$container" \
  --env RENDER_API_TOKEN \
  --env TEST_WORTEN \
  --env ALLOWED_DOMAINS=example.com,worten.pt \
  "$image" >/dev/null

if docker exec "$container" python -c '
import json
import time
import urllib.error
import urllib.request

url = "http://127.0.0.1:8080/health"
deadline = time.monotonic() + 30
last_observation = "no response yet"
while True:
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            status = response.status
            body = json.loads(response.read())
        if status == 200 and isinstance(body, dict) and body.get("status") == "ok":
            print("Health: PASS (HTTP 200; status=ok)")
            break
        last_observation = "HTTP %s or unexpected response schema" % status
    except urllib.error.HTTPError as exc:
        last_observation = "HTTP %s" % exc.code
    except Exception as exc:
        reason = getattr(exc, "reason", None)
        detail = str(reason) if reason is not None else str(exc)
        last_observation = (type(exc).__name__ + ": " + detail)[:160]
    if time.monotonic() >= deadline:
        raise SystemExit("FAIL: /health não ficou disponível em 30 segundos; última observação: " + last_observation)
    time.sleep(1)
'; then
  :
else
  health_status=$?
  echo "FAIL: health probe terminou com código $health_status; estado do container:"
  docker inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom_killed={{.State.OOMKilled}} error={{.State.Error}}' "$container" || true
  running="$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo unknown)"
  echo "Container running: $running"
  echo "Comando configurado (sem variáveis de ambiente):"
  docker inspect --format 'Path={{.Path}} Args={{json .Args}} Entrypoint={{json .Config.Entrypoint}} Cmd={{json .Config.Cmd}}' "$container" || true
  echo "Processos xvfb-run, Xvfb, Python e Uvicorn:"
  docker top "$container" -eo pid,ppid,stat,comm,args 2>/dev/null | grep -E '[x]vfb-run|[X]vfb|[p]ython|[u]vicorn' || true
  echo "PID 1 cmdline:"
  docker exec "$container" python -c 'from pathlib import Path; print(Path("/proc/1/cmdline").read_bytes().replace(bytes([0]), b" ").decode("utf-8", "replace"))' || true
  echo "FastAPI module import check (no environment values):"
  docker exec "$container" python -c 'import app; print("app import: PASS; FastAPI instance:", type(app.app).__name__)' || echo "app import: FAIL (ver traceback nos logs abaixo)"
  echo "Listener TCP e ligação direta a 127.0.0.1:8080:"
  docker exec "$container" python -c '
import socket

found = False
for table in ("/proc/net/tcp", "/proc/net/tcp6"):
    try:
        with open(table, encoding="ascii") as stream:
            for line in stream.readlines()[1:]:
                fields = line.split()
                if len(fields) > 3 and fields[1].rsplit(":", 1)[-1].upper() == "1F90" and fields[3] == "0A":
                    print("LISTEN:", table, fields[1])
                    found = True
    except OSError as exc:
        print("socket table unavailable:", type(exc).__name__)
if not found:
    print("LISTEN: no socket found on port 8080")
try:
    connection = socket.create_connection(("127.0.0.1", 8080), timeout=3)
    connection.close()
    print("TCP connect 127.0.0.1:8080: PASS")
except OSError as exc:
    print("TCP connect 127.0.0.1:8080: FAIL:", type(exc).__name__, str(exc)[:160])
' || true
  echo "Últimas 150 linhas dos logs do container:"
  docker logs --tail 150 "$container" || true
  exit "$health_status"
fi

if docker exec "$container" python -c '
import json
import os
import re
import urllib.error
import urllib.request

base = "http://127.0.0.1:8080"
token = os.environ["RENDER_API_TOKEN"]
render_fields = {"blocked_reason", "title", "final_url", "html", "text", "content_bytes", "http_status", "metrics"}

def valid_render_result(body):
    return (
        isinstance(body, dict)
        and render_fields.issubset(body)
        and isinstance(body.get("title"), str)
        and isinstance(body.get("final_url"), str)
        and isinstance(body.get("html"), str)
        and isinstance(body.get("text"), str)
        and isinstance(body.get("content_bytes"), int)
        and not isinstance(body.get("content_bytes"), bool)
        and (body.get("blocked_reason") is None or isinstance(body.get("blocked_reason"), str))
        and (
            body.get("http_status") is None
            or (isinstance(body.get("http_status"), int) and not isinstance(body.get("http_status"), bool))
        )
        and isinstance(body.get("metrics"), dict)
        and isinstance(body["metrics"].get("duration_ms"), int)
        and not isinstance(body["metrics"].get("duration_ms"), bool)
        and isinstance(body["metrics"].get("proxy_blocked_requests"), int)
        and not isinstance(body["metrics"].get("proxy_blocked_requests"), bool)
    )

def request(path, payload):
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        base + path,
        data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            status = response.status
            raw = response.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read()
    except urllib.error.URLError:
        return None, None
    except Exception:
        return None, None
    try:
        return status, json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return status, None

def report_render_failure(status, body):
    print("Render example.com: FAIL")
    if status is None:
        print("HTTP status: unavailable (no HTTP response received)")
        print("Response structure: unavailable (transport failure)")
        print("Application status: unavailable")
        print("Structured error code: unavailable")
        return
    print("HTTP status: %s" % status)
    if body is None:
        print("Response structure: invalid (response is not JSON)")
        print("Application status: unavailable")
        print("Structured error code: unavailable")
        return
    if not isinstance(body, dict):
        print("Response structure: invalid (JSON root is not an object)")
        print("Application status: unavailable")
        print("Structured error code: unavailable")
        return

    detail = body.get("detail")
    app_status = body.get("status")
    error_object = body
    if not isinstance(app_status, str) and isinstance(detail, dict):
        app_status = detail.get("status")
        error_object = detail
    if isinstance(app_status, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,31}", app_status):
        print("Application status: %s" % app_status)
    else:
        print("Application status: unavailable")

    error_code = error_object.get("error") if isinstance(error_object, dict) else None
    if isinstance(error_code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", error_code):
        print("Structured error code: %s" % error_code)
    else:
        print("Structured error code: unavailable")

    if app_status in ("rendered", "blocked"):
        if valid_render_result(body):
            print("Response structure: valid render result")
        else:
            print("Response structure: invalid (render result fields missing)")
    elif app_status == "error" and isinstance(error_code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", error_code):
        print("Response structure: valid structured error")
    else:
        print("Response structure: unexpected")

if not os.path.isfile("/usr/bin/chromium"):
    raise SystemExit("FAIL: Chromium não está instalado na imagem")

if os.environ.get("TEST_WORTEN", "true").lower() != "true":
    status, body = request("/render", {"url": "https://example.com/"})
    if (
        status != 200
        or not isinstance(body, dict)
        or body.get("status") != "rendered"
        or not valid_render_result(body)
        or not body.get("title")
        or not body.get("html")
        or not body.get("text")
        or body.get("content_bytes", 0) <= 0
    ):
        report_render_failure(status, body)
        raise SystemExit(1)
    print("Render example.com: PASS (Chromium devolveu título e conteúdo)")
else:
    print("Render example.com: SKIPPED because TEST_WORTEN mode runs the separate site scenario")

if os.environ.get("TEST_WORTEN", "true").lower() == "true":
    worten_url = "https://www.worten.pt/produtos/maquina-de-cafe-philips-ep3241-50-s3200-pr-outlet-grade-a-15-bar-12-niveis-de-moagem-7652626"
    status, body = request("/render", {"url": worten_url})
    if status != 200:
        code = body.get("detail", {}).get("error", "HTTP_ERROR") if isinstance(body, dict) else "HTTP_ERROR"
        raise SystemExit("FAIL: pedido Worten devolveu HTTP %d (%s)" % (status, code))
    if body.get("status") == "blocked":
        reason = body.get("blocked_reason") or "unspecified"
        print("Worten: BLOCKED (%s); tratado como bloqueio/desafio, não como indisponibilidade do produto" % reason)
    elif body.get("status") == "rendered":
        if not body.get("title") or not body.get("html") or not body.get("text"):
            raise SystemExit("FAIL: resposta Worten marcada rendered sem conteúdo")
        print("Worten: PASS (Chromium devolveu conteúdo renderizado)")
    else:
        raise SystemExit("FAIL: resposta Worten sem estado rendered/blocked reconhecido")
else:
    print("Worten: SKIPPED (desativado por substituição do Cloud Build)")
'; then
  :
else
  render_status=$?
  echo "Chromium startup diagnostics (sanitized; no page data or environment values):"
  docker exec -i "$container" python - <<'PY' || true
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import asyncio
import logging

binary = os.environ.get("CHROME_BIN") or "/usr/bin/chromium"
path = pathlib.Path(binary)
print("binary_path=" + binary)
print("binary_exists=" + str(path.exists()).lower())
print("binary_executable=" + str(os.access(binary, os.X_OK)).lower())
print("binary_resolved=" + str(path.resolve(strict=False)))
print("runtime_uid=" + str(os.getuid() if hasattr(os, "getuid") else "unknown"))
try:
    probe = tempfile.NamedTemporaryFile(prefix="watchly-write-probe-", dir="/tmp", delete=True)
    probe.close()
    print("tmp_writable=true")
except OSError as exc:
    print("tmp_writable=false error_type=" + type(exc).__name__)

if path.exists() and os.access(binary, os.X_OK):
    try:
        version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=8)
        match = re.search(r"Chrom(?:e|ium)\s+[0-9]+(?:\.[0-9]+){1,4}", version.stdout + version.stderr)
        print("version_exit=" + str(version.returncode))
        print("browser_version=" + (match.group(0) if match else "unavailable"))
    except subprocess.TimeoutExpired:
        print("version_probe=timeout")
    except OSError as exc:
        print("version_probe=failed error_type=" + type(exc).__name__)

    elf_candidates = []
    try:
        package_files = subprocess.run(
            ["dpkg-query", "-L", "chromium"], capture_output=True, text=True, timeout=8
        )
        if package_files.returncode == 0:
            for candidate in package_files.stdout.splitlines():
                candidate_path = pathlib.Path(candidate)
                try:
                    if candidate_path.is_file() and os.access(candidate, os.X_OK):
                        with candidate_path.open("rb") as stream:
                            if stream.read(4) == b"\x7fELF":
                                elf_candidates.append(candidate)
                except OSError:
                    continue
    except (OSError, subprocess.TimeoutExpired):
        pass

    resolved = elf_candidates[0] if elf_candidates else str(path.resolve(strict=False))
    print("chromium_elf=" + (resolved if elf_candidates else "not_found_in_package_manifest"))
    ldd = shutil.which("ldd")
    if ldd and elf_candidates:
        try:
            deps = subprocess.run([ldd, resolved], capture_output=True, text=True, timeout=8)
            missing = re.findall(r"^\s*([A-Za-z0-9_.+-]+)\s+=>\s+not found\s*$", deps.stdout + deps.stderr, re.M)
            if missing:
                print("missing_shared_libraries=" + ",".join(sorted(set(missing))))
            else:
                print("missing_shared_libraries=none_detected")
        except (OSError, subprocess.TimeoutExpired) as exc:
            print("shared_library_probe=failed error_type=" + type(exc).__name__)
    elif not ldd:
        print("shared_library_probe=ldd_unavailable")
    else:
        print("shared_library_probe=chromium_elf_unresolved")

    profile = tempfile.mkdtemp(prefix="watchly-chromium-diagnostic-")
    try:
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
            result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=15)
            error_text = result.stderr.lower()
            if result.returncode == 0:
                category = "none"
                result_label = "PASS"
            elif "error while loading shared libraries" in error_text:
                category = "missing_shared_library"
                result_label = "FAIL"
            elif "failed to move to new namespace" in error_text and "operation not permitted" in error_text:
                category = "namespace_creation_denied"
                result_label = "FAIL"
            elif "failed to move to new namespace" in error_text:
                category = "namespace_creation_failed"
                result_label = "FAIL"
            elif "no usable sandbox" in error_text:
                category = "sandbox_unavailable"
                result_label = "FAIL"
            elif "suid sandbox" in error_text and ("not configured correctly" in error_text or "needs to be owned" in error_text):
                category = "suid_sandbox_misconfigured"
                result_label = "FAIL"
            elif "sandbox" in error_text or "namespace" in error_text:
                category = "sandbox_or_namespace_unclassified"
                result_label = "FAIL"
            elif "permission denied" in error_text:
                category = "permission_denied"
                result_label = "FAIL"
            elif "cannot open display" in error_text:
                category = "display_unavailable"
                result_label = "FAIL"
            else:
                category = "unclassified_process_exit"
                result_label = "FAIL"
            print("direct_headless_about_blank=" + result_label + " exit=" + str(result.returncode) + " stderr_category=" + category)
        except subprocess.TimeoutExpired:
            print("direct_headless_about_blank=TIMEOUT")
        except OSError as exc:
            print("direct_headless_about_blank=FAILED error_type=" + type(exc).__name__)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
else:
    print("direct_headless_about_blank=SKIPPED binary_unavailable_or_not_executable")

class SafeNodriverHandler(logging.Handler):
    def emit(self, record):
        if record.getMessage() == "could not start":
            exc_type = record.exc_info[0].__name__ if record.exc_info and record.exc_info[0] else "unavailable"
            print("nodriver_cdp_probe=failed underlying_error_type=" + exc_type)

async def probe_nodriver_startup():
    import nodriver

    browser_logger = logging.getLogger("nodriver.core.browser")
    original_level = browser_logger.level
    original_propagate = browser_logger.propagate
    original_handlers = browser_logger.handlers[:]
    for existing_handler in original_handlers:
        browser_logger.removeHandler(existing_handler)
    handler = SafeNodriverHandler()
    browser_logger.addHandler(handler)
    browser_logger.setLevel(logging.DEBUG)
    browser_logger.propagate = False
    profile = tempfile.mkdtemp(prefix="watchly-nodriver-diagnostic-")
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
            timeout=20,
        )
        print("nodriver_cdp_probe=PASS")
    except asyncio.TimeoutError:
        print("nodriver_cdp_probe=TIMEOUT")
    except Exception as exc:
        cause_type = type(exc.__cause__).__name__ if exc.__cause__ is not None else "none"
        context_type = type(exc.__context__).__name__ if exc.__context__ is not None else "none"
        print(
            "nodriver_cdp_probe=failed error_type=" + type(exc).__name__
            + " cause_type=" + cause_type + " context_type=" + context_type
        )
    finally:
        if browser is not None:
            try:
                browser.stop()
            except Exception as exc:
                print("nodriver_cdp_cleanup=failed error_type=" + type(exc).__name__)
        browser_logger.removeHandler(handler)
        for existing_handler in original_handlers:
            browser_logger.addHandler(existing_handler)
        browser_logger.setLevel(original_level)
        browser_logger.propagate = original_propagate
        shutil.rmtree(profile, ignore_errors=True)

try:
    asyncio.run(probe_nodriver_startup())
except Exception as exc:
    print("nodriver_cdp_probe=diagnostic_error error_type=" + type(exc).__name__)
PY
  echo "Falha no teste de renderização; logs sanitizados da aplicação (últimas 150 linhas):"
  docker logs --tail 150 "$container" || true
  exit "$render_status"
fi

echo "Smoke tests finished; cleanup will remove the test container."

# Watchly Cloud Run check service (local)

Requires Node.js 22.6+ with TypeScript stripping support (the current project uses Node 26). No Google Cloud account is needed for local execution.

## Environment

- `PORT` — listen port, default `8080`.
- `WATCHLY_HMAC_SECRET` — required shared secret. Supply it through the shell or a local, untracked environment file; never commit or log it.

PowerShell example:

```powershell
$env:PORT = "8080"
$env:WATCHLY_HMAC_SECRET = "<local-random-secret>"
npm run cloud-run:dev
```

The server binds `0.0.0.0`, as required by Cloud Run containers.

## Endpoints

- `GET /health` returns `{"status":"ok"}` without running a check.
- `POST /v1/check` requires `Content-Type: application/json`, `X-Watchly-Timestamp` (Unix seconds), and `X-Watchly-Signature` (lowercase hex HMAC-SHA256). The signed bytes are `timestamp + LF + exact request-body bytes`. Timestamps more than five minutes from server time are rejected.

The JSON body accepts only `url` and optional `previousHash` (64 hexadecimal characters). Unknown properties are rejected. The response contains the outcome, upstream HTTP status/content type, received site bytes, normalized text/hash and execution metrics. Authentication and validation errors return structured JSON without stack traces.

This service is not yet integrated with the Cloudflare Worker. Local requests must be signed with the same secret; there is no public/unauthenticated check mode.

## Local smoke test

From the repository root, run the one-command smoke test:

```powershell
.\cloud-run\smoke-test.ps1
```

The script generates a fresh in-memory secret and ephemeral port, starts the service as a child process with `PORT` and `WATCHLY_HMAC_SECRET` set only in that child environment, waits up to 15 seconds for `/health`, and runs the four checks. It signs the exact UTF-8 JSON bytes using `timestamp + LF + body`. It prints PASS/FAIL labels only, never the secret or signatures, and always stops the server process tree it started. If startup fails because the selected port became occupied, it reports the problem and leaves the other process untouched.

## Remote smoke test after deployment

After the `watchly-check` Cloud Run revision is deployed, run from PowerShell 7 at the repository root:

```powershell
.\cloud-run\remote-smoke-test.ps1
```

The script checks the fixed `watchly-check` service URL: `GET /health`, a validly signed `POST /v1/check` for `https://example.com/`, then the same request with an invalid signature. It retrieves version 2 of `watchly-hmac-secret` from project `watchly-514121` via `gcloud secrets versions access`; `gcloud` must be installed and authenticated as an identity with `secretmanager.versions.access` on that secret. The secret and generated signatures are captured only in process memory and are never printed or written to files. The script prints a PASS/FAIL result per check and exits non-zero if a check fails. It sends requests to the deployed service and should only be run when a remote smoke test is intended.

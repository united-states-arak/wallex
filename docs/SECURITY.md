# Security

starcoach-trader controls a funded exchange account through an API key and talks to an AI model and public news feeds. It was built security-first: secrets never touch disk or logs, every outbound connection is encrypted and bounded, every order passes independent safety checks before it leaves the process, and the operator can stop the bot instantly. This document describes the threat model, every control, how each one is verified, and how the controls line up with recognised security standards.

To report a vulnerability, see [SECURITY.md](../SECURITY.md) at the repository root.

## 1. Assets and threat model

| Asset | What could go wrong | Primary controls |
|---|---|---|
| Wallex API key | Leaked through git, logs, error messages, a container image, a redirect or an AI prompt | Environment-only secrets, redaction of every log line and error, git and docker ignore rules, gitleaks in CI, TLS with redirects refused, the key never enters a prompt |
| Account funds | Runaway orders, fat-finger sizes, orders far from the market, trading outside allowed markets, manipulation through news | Risk guard, stop-based sizing, 50% position cap, independent order sanity check, allowed-market check, AI limited to veto or shrink, kill switch |
| AI API key | Leaked through logs or upstream error echoes | Redaction, TLS, timeouts, key masked in fallback reasons |
| Decision log and state | Tampering, disclosure, loss on restart | Owner-only file permissions, atomic writes, git SHA and config hash on every record, read-only mounts for the dashboard |
| Operator controls (dashboard) | Remote or cross-site activation of the kill switch, clickjacking, XSS | Loopback binding, Host and Origin checks, confirm header, token authentication, rate limit, strict security headers and CSP |
| Build and dependencies | Malicious package, vulnerable dependency, secret committed | 8 runtime dependencies, frozen lockfile, install scripts disabled, `bun audit`, Dependabot, CI secret scanning |

Trust boundaries: the Wallex API, the AI provider and the news feeds are external and untrusted. Their responses are size-limited, parsed defensively and validated before use. Headlines are treated as hostile text.

## 2. Secrets management

| Control | Implementation | Where |
|---|---|---|
| Secrets live in the environment only | `WALLEX_API_KEY`, `AI_API_KEY` and `DASHBOARD_TOKEN` are declared as secrets in the typed environment schema | `src/env-schema.ts` |
| Config files can never hold a secret | The settings loader refuses any `.toml` file that contains a secret-looking key, with an explicit error | `src/settings/index.ts`, `test/security.test.ts` |
| Nothing secret is committed | `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key` are git-ignored. `opencode.json` references the key as `{env:WALLEX_API_KEY}` | `.gitignore`, `opencode.json` |
| Nothing secret enters the image | `.dockerignore` excludes `.env*`, state, logs and data. Secrets are injected at run time through `env_file` | `.dockerignore`, `docker-compose.yml` |
| Redaction everywhere | Every decision-log line passes through deep redaction before it is written: configured secret values, bearer tokens, `sk-` keys and `key=value` credential patterns are masked, and fields named like credentials are replaced | `src/security/redact.ts`, `src/log.ts` |
| Upstream error echoes are scrubbed | Wallex error messages are redacted and truncated before they are logged or shown. AI fallback reasons mask the AI key | `src/wallex/rest.ts`, `src/ai/supervisor.ts` |
| Tests never see real keys | The test preload removes every application variable before any test runs | `test/setup.ts` |
| Secret scanning | gitleaks scans the full history on every push and pull request | `.github/workflows/ci.yml` |
| Least-privilege key | The operator uses a trade-only Wallex key. The code contains no withdrawal or transfer call at all | `src/wallex/rest.ts`, [SECURITY.md](../SECURITY.md) |

## 3. Transport and outbound requests

| Control | Implementation |
|---|---|
| TLS required | The Wallex client refuses a non-`https` base URL at construction. Config validation refuses plain-`http` URLs for Wallex, the AI endpoint and the news feeds (a model server on the local machine is the only exception), and for the OTLP exporter unless it is on the local machine or a collector on the same Docker network |
| Certificate validation always on | No code path or configuration disables certificate verification |
| No redirects with credentials | Wallex requests use `redirect: 'error'`, so the key header can never be forwarded to another host |
| Bounded responses | Wallex responses are capped at 8 MB and news payloads at 1 MB while streaming, before parsing |
| Timeouts on every call | Wallex requests (`wallex.requestTimeoutMs`, 10 s), news requests (8 s), the whole AI review (`AI_TIMEOUT_MS`, 12 s) |
| Fixed destinations | Every outbound URL comes from validated configuration. No URL is ever built from market data, news content or model output |

## 4. Input validation

| Input | Validation |
|---|---|
| Environment | Zod schema via `@t3-oss/env-core`. Any invalid value stops the process with exit code 78 and a list of problems |
| Configuration | Typed, layered settings. Unknown keys are errors, every number has a range, cross-field rules are enforced. `bun run config validate` checks every profile |
| Identifiers sent to the exchange | Market symbols must match `^[A-Z0-9]{2,20}$`, client order ids `^[A-Za-z0-9_-]{1,64}$`, and ids are URL-encoded |
| Orders | Every order is rounded to the market's tick and step, checked against minimum quantity and notional, refused on blocked markets, and market orders are refused where the exchange disables them | 
| Exchange responses | Parsed defensively; the shapes were verified against the live API (see [WALLEX.md](WALLEX.md)) |
| AI output | The verdict must match a strict JSON schema (`approve`, `veto` or `resize`, a size multiplier clamped to 0..1, a reason of at most 600 characters). Anything else is a tool error the model must correct, or a safe fallback |
| News headlines | Control characters, bidirectional overrides, markup and backticks are stripped and titles are cut to 160 characters before they reach a prompt |
| Dashboard requests | Request bodies are limited to 1 KB and must be valid JSON of the expected shape. Query filters are limited to 200 characters |

## 5. Trading safety controls

Financial safety is layered so that no single component can cause a large loss.

| Layer | Control | Where |
|---|---|---|
| 1. Strategy | Position size derived from the stop so a stop-out costs about 1% of equity; at most 50% of equity per position; at most 2 positions | `src/strategy/engine.ts` |
| 2. Risk guard | Day-loss halt at 12% below the day's peak, hard halt at 30% below start, profit-lock risk reduction, kill-switch file | `src/risk/guard.ts` |
| 3. AI supervisor | Can veto or shrink a trade, never create one, enlarge one, change prices or touch the guard. The size multiplier is clamped in two places | `src/ai/supervisor.ts` |
| 4. Order validation | Allowed markets only (`config/blocked-markets.txt`), exchange rounding and minimums | `src/exchange/validate.ts` |
| 5. Order sanity check | Independent of everything above, the live adapter refuses a BUY worth more than `risk.maxOrderTmn` (3,000,000 TMN), priced more than `risk.maxPriceDeviation` (3%) above the live ask, or below half the bid. Sells are never blocked, so a position can always be closed | `src/exchange/live.ts` |
| 6. Live confirmation | Real orders need the API key and an explicit `--confirm-live` flag or `STARCOACH_CONFIRM_LIVE=yes`. Without them the daemon runs paper or dry only | `src/cli.ts`, `docker/entrypoint.sh` |
| 7. Kill switch | Creating `STOP` blocks every new entry within one poll cycle, from the shell or the dashboard | `src/risk/guard.ts` |
| 8. TMN-only exit | Pullout sells holdings only through their TMN market, never through other quote currencies | `src/pullout.ts` |

Prompt injection: headlines are untrusted. Because the AI can only veto or shrink, the worst a malicious headline can achieve is skipping or reducing a trade the rules already allowed.

## 6. Operator dashboard

| Control | Implementation |
|---|---|
| Local by default | Binds to `127.0.0.1`. Docker publishes it on `127.0.0.1` only |
| Host header check | Requests for unexpected host names are refused (DNS-rebinding defence) |
| Cross-site protection | State-changing requests need a same-origin `Origin` / `Sec-Fetch-Site`, a custom `x-confirm: stop` header (which a cross-site form cannot send) and a JSON body |
| Authentication | When `DASHBOARD_TOKEN` is set, the kill switch requires it (`x-dashboard-token` or `Authorization: Bearer`), compared in constant time. When the dashboard is reachable from other machines without a token, the kill switch is disabled |
| Abuse limits | 20 state-changing requests per minute, 1 KB bodies, 30 s idle timeout |
| Security headers | `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy`, `Cache-Control: no-store` |
| No path traversal | Static files are served from a fixed allow-list, never from the request path |
| Output encoding | Values taken from the decision log are HTML-escaped (`esc`) before rendering, and the CSP allows scripts from the dashboard's own origin only, never inline |
| Read-only data | In Docker the dashboard mounts logs and state read-only |

## 7. Container and runtime hardening

| Control | Setting |
|---|---|
| Non-root | The image runs as the unprivileged `bun` user. CI asserts the image user is not root |
| Read-only root filesystem | `read_only: true`, with `tmpfs` for `/tmp` and explicit volumes for state, logs, data and the kill switch |
| No capabilities | `cap_drop: [ALL]` |
| No privilege escalation | `security_opt: no-new-privileges:true` |
| Resource limits | `pids_limit: 256`, `mem_limit: 1g` |
| Minimal exposure | Ports published on `127.0.0.1` only. Config mounted read-only |
| Reproducible build | Pinned Bun version, `bun install --frozen-lockfile --production --ignore-scripts`, OCI labels with the git revision |
| Process supervision | `init: true`, `SIGTERM` handled (stop entries, cancel pending buys, save state), restart policy, health check on log freshness |
| Owner-only files | Decision logs and state files are created with mode `0600` in `0700` directories, written atomically |

## 8. Supply chain and development lifecycle

| Control | Implementation |
|---|---|
| Small dependency surface | 8 runtime dependencies: five OpenTelemetry packages, `@t3-oss/env-core`, `zod` and `libfx` |
| Locked dependencies | `bun.lock` committed and installed with `--frozen-lockfile` everywhere |
| No install scripts | `--ignore-scripts` in the image and in CI |
| Vulnerability scanning | `bun audit` in CI and on a weekly schedule (currently: no known vulnerabilities) |
| Automated updates | Dependabot for Bun packages, GitHub Actions and the Docker base image |
| Continuous integration | Type check, the full test suite, dependency audit, secret scan and a non-root image build on every push and pull request, with read-only workflow permissions |
| Security tests | `test/security.test.ts` (redaction, log permissions, response limits, constant-time compare, TLS rules, headline sanitisation, config secret refusal, dashboard authentication, body limits, rate limiting, headers), `test/live-exchange.test.ts` (order sanity, fill parsing, identifier validation, TLS), `test/dashboard.test.ts` (origin checks, confirm header, path traversal) |
| Traceability | Every log record carries the git SHA; the startup banner and `daemon.start` carry the config hash, so any run maps to exact code and settings |

## 9. Monitoring and incident response

| Situation | Response |
|---|---|
| Stop new trades now | `touch STOP` (Docker: `touch control/STOP`) or the dashboard button. Effective within one poll cycle |
| Close everything | `bun run pullout` to review, `bun run pullout --yes` to sell all holdings to TMN |
| Suspected key exposure | Revoke the key in the Wallex panel first, rotate `WALLEX_API_KEY`, restart. The decision log shows every order with its reason, so unexpected activity is easy to spot |
| Anomaly detection | Prometheus metrics and 10 Grafana alert rules: bot down, guard halted, drawdown, day loss, equity floor, API error rate, rejected exits, AI fallback ratio, stale data, run ending with positions |
| Health | Container health check on decision-log freshness; `daemon.degraded` alarm when the exchange is unreachable with positions open |

## 10. Alignment with security standards

The controls above implement the applicable requirements of these standards for a single-tenant trading service:

### OWASP Top 10 (2021)

| Risk | How it is addressed |
|---|---|
| A01 Broken Access Control | Loopback binding, Host and Origin checks, token-protected kill switch, read-only mounts |
| A02 Cryptographic Failures | TLS for every remote endpoint, certificate validation never disabled, secrets only in the environment, constant-time token comparison |
| A03 Injection | Strict identifier patterns, URL encoding, JSON-only bodies, CSP and output encoding, sanitised headlines for prompts |
| A04 Insecure Design | Threat model, defence in depth for orders (eight layers), AI limited to veto or shrink by design |
| A05 Security Misconfiguration | Validated typed config, unknown keys rejected, secure defaults (paper mode, loopback binding, live needs confirmation), hardened container |
| A06 Vulnerable and Outdated Components | Minimal dependencies, lockfile, `bun audit`, Dependabot |
| A07 Identification and Authentication Failures | Shared-secret token with a minimum length, constant-time comparison, kill switch disabled on remote binding without a token |
| A08 Software and Data Integrity Failures | Frozen lockfile, no install scripts, atomic state writes, git SHA and config hash on every record |
| A09 Security Logging and Monitoring Failures | Structured decision log for every decision, metrics, alert rules, health checks, redaction so logs can be shared safely |
| A10 Server-Side Request Forgery | Fixed, validated destinations; no URL from external data; redirects refused |

### OWASP API Security Top 10 (2023), as an API consumer and for the dashboard API

Resource consumption is bounded (API4: size caps, timeouts, rate limits), function-level authorisation protects the only state-changing endpoint (API5), the exchange is never sent unvalidated identifiers (API8), and responses from third-party APIs are treated as untrusted (API10).

### CWE Top 25

| Weakness | Mitigation |
|---|---|
| CWE-79 Cross-site scripting | CSP without inline scripts, HTML escaping of log values in the UI |
| CWE-352 CSRF | Same-origin checks, custom header, JSON body, token |
| CWE-22 Path traversal | Static file allow-list |
| CWE-20 Improper input validation | Schemas for environment, config, AI output, dashboard input and identifiers |
| CWE-798 Hard-coded credentials | None in code or config; enforced by the loader and gitleaks |
| CWE-200 and CWE-532 Information exposure, secrets in logs | Deep redaction of every log line and error, owner-only log files |
| CWE-400 Uncontrolled resource consumption | Response caps, request body caps, timeouts, rate limit, container limits |
| CWE-918 SSRF | Fixed destinations, TLS, redirects refused |
| CWE-269 and CWE-250 Excessive privilege | Non-root user, no capabilities, no new privileges, trade-only key |

### OWASP ASVS 4.0 (Level 1, applicable chapters)

V1 architecture and threat model (section 1), V2 authentication for the dashboard token, V5 validation and encoding (section 4), V7 logging without sensitive data (section 2), V8 data protection (owner-only files, no secrets at rest), V9 communications (section 3), V10 malicious code and dependencies (section 8), V12 files (allow-listed static files, atomic writes), V13 API (section 6), V14 configuration (sections 2, 7 and 8).

### NIST Secure Software Development Framework (SP 800-218)

Prepare the organisation (PO): documented security requirements and this policy. Protect the software (PS): protected secrets, lockfile, traceable releases by git SHA. Produce well-secured software (PW): threat model, secure defaults, security tests in CI, code review of every dependency change via Dependabot pull requests. Respond to vulnerabilities (RV): reporting policy, weekly audits, documented incident response.

### CIS Docker Benchmark (container runtime)

Non-root user (4.1), memory and PID limits (5.10, 5.28), capabilities dropped (5.3), read-only root filesystem (5.12), ports bound to the host interface explicitly (5.13), no new privileges (5.25), health check defined (4.6), no secrets in the image (4.10).

### Twelve-Factor App

Configuration and secrets strictly in the environment, logs as event streams (JSONL), disposable processes with graceful shutdown and restart-safe state.

## 11. Verify it yourself

```bash
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test test/security.test.ts test/live-exchange.test.ts test/dashboard.test.ts
bun audit
bun run config validate
docker compose config -q && docker build -t starcoach-trader:check .
docker run --rm --entrypoint id starcoach-trader:check -u     # not 0
```

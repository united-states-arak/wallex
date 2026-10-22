# Starcoach monitoring

The daemon exports OpenTelemetry metrics derived from its own JSONL log events (`src/telemetry/otel.ts`).
Nothing in the trading path awaits telemetry, and any telemetry error is swallowed.

## Start the stack

```sh
# 1. the bot (live, --paper or --dry); the scrape URL is printed at startup
bun src/cli.ts live --paper --run-end 2026-10-23T09:00:00Z
#    metrics: http://127.0.0.1:9464/metrics

# 2. Prometheus + Grafana
docker compose -f ops/docker-compose.yml up -d
```

| What | URL |
| --- | --- |
| Grafana (admin / admin, override with `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD`) | http://localhost:3000 |
| Dashboard "Starcoach trader" (folder Starcoach) | http://localhost:3000/d/starcoach-trader |
| Alert rules | http://localhost:3000/alerting/list |
| Prometheus | http://localhost:9090 |
| Raw bot metrics | http://127.0.0.1:9464/metrics |

Prometheus scrapes `host.docker.internal:9464`. The bot binds `127.0.0.1` by default, which Docker Desktop
(macOS/Windows) can reach. On Linux start the bot with `OTEL_PROMETHEUS_HOST=0.0.0.0` (and firewall the port).

## Configuration (environment)

| Variable | Default | Effect |
| --- | --- | --- |
| `OTEL_SDK_DISABLED=true` | off | disables all telemetry (same as `--no-metrics`) |
| `OTEL_PROMETHEUS_PORT` | `9464` | scrape port |
| `OTEL_PROMETHEUS_HOST` | `127.0.0.1` | bind address |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | when set, also push OTLP/HTTP every 10 s (`/v1/metrics` is appended) |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | full metrics URL, takes precedence |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | `key=value,key2=value2`, e.g. the Grafana Cloud `Authorization=Basic ...` |

If the port is taken the bot prints one line and keeps trading without a metrics endpoint.

## Grafana Cloud (push, no local stack)

Create an access policy token with `metrics:write` and copy the OTLP endpoint and instance ID from
Grafana Cloud, Connections, OpenTelemetry. Then:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<region>.grafana.net/otlp
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(printf '<instance-id>:<token>' | base64)"
bun src/cli.ts live ...
```

Resource attributes sent: `service.name=starcoach-trader`, `service.version` and `git.sha` (short commit), `mode`.
Grafana Cloud converts them to `target_info`; the series themselves are the `starcoach_*` names below.
Import `ops/grafana/dashboards/starcoach.json` (Dashboards, New, Import) and pick your Prometheus data source in the
"Data source" variable. For alerts, copy the rules from `ops/grafana/provisioning/alerting/alerts.yml` or POST the file
through the provisioning API; the rules use data source UID `prometheus`, so change `datasourceUid` to your Cloud
Prometheus UID first.

OTLP is cumulative, as Prometheus expects. Do not push OTLP and scrape the same Prometheus at once: series would exist
twice and `sum()` based alerts would double count.

## Optional collector

`docker compose -f ops/docker-compose.yml --profile collector up -d` starts an OpenTelemetry collector on `:4318`
that remote-writes to the local Prometheus. Use it instead of the scrape job: comment out the `starcoach` job in
`ops/prometheus.yml` and run the bot with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.

## Metrics

All `*_pct` values are fractions (`0.06` = 6%), like the risk guard. Gauges are read at scrape time.

- Gauges: `starcoach_up{mode,sha}`, `starcoach_equity_tmn`, `starcoach_start_equity_tmn`, `starcoach_pnl_pct`,
  `starcoach_day_pnl_pct`, `starcoach_drawdown_pct`, `starcoach_risk_pct`, `starcoach_guard_halted{reason}`,
  `starcoach_open_positions`, `starcoach_exposure_pct`, `starcoach_run_seconds_remaining`,
  `starcoach_heartbeat_age_seconds`, `starcoach_last_bar_age_seconds{symbol}`, `starcoach_consecutive_losses`.
- Counters: `starcoach_orders_total{symbol,side,status}`, `starcoach_trades_closed_total{symbol,result,how}`,
  `starcoach_setups_total{outcome,reason,model}`, `starcoach_ai_verdicts_total{action,source}`,
  `starcoach_api_errors_total{kind}`, `starcoach_poll_errors_total{symbol}`, `starcoach_exec_rejected_total{kind}`,
  `starcoach_daemon_degraded_total`, `starcoach_events_total{event}`.
- Histograms: `starcoach_trade_pnl_pct`, `starcoach_ai_latency_ms`, `starcoach_decision_latency_ms`,
  `starcoach_order_latency_ms`.

`starcoach_guard_halted` is 1 for a daily-loss or hard-drawdown halt and for the `STOP` kill file. Temporary pauses
(loss streak, entries per hour) are not halts; they show up as rejected setups with reason `guard_loss_pause` or
`max_entries_per_hour`.

## Alerts

Rules are in `ops/grafana/provisioning/alerting/alerts.yml` (folder Starcoach, group `starcoach`, 1 m evaluation):

| Rule | Condition | Severity |
| --- | --- | --- |
| Bot down or heartbeat stale | heartbeat age > 120 s, or no series | critical |
| Risk guard halted | `starcoach_guard_halted` > 0 | critical |
| Drawdown from day peak | > 6% for 2 m | warning |
| Day PnL | < -8% for 2 m | critical |
| Equity floor | equity < 70% of start for 2 m | critical |
| API errors | > 5 per minute for 5 m | warning |
| Stuck exit | any rejected `exit` or `tp` order in 5 m | critical |
| AI fallback ratio | > 50% over 15 m (needs 3+ verdicts) | warning |
| Symbol bar age | > 300 s for 2 m | warning |
| Run ending | < 20 min to RUN_END with positions open | critical |

Every rule carries `severity` and `app=starcoach` labels, so routing is done by label.

## Notification channels

Provisioning ships rules only, not contact points, because they hold secrets. Wire them once:

1. Alerting, Contact points, New: Telegram (bot token + chat id), Slack webhook, e-mail or PagerDuty. Use "Test".
2. Alerting, Notification policies: edit the default policy to use that contact point. Optionally add a nested
   policy matching `severity = critical` with a short repeat interval (for example 15 m) and a louder channel.
3. Optional: provision it as code under `ops/grafana/provisioning/alerting/` with a `contactPoints:` and `policies:`
   file (keep the tokens in environment variables, `$TELEGRAM_TOKEN` style, supported by Grafana provisioning).

"Bot down" fires on missing data on purpose: if the process dies, the series disappear and the rule still alerts.

## Validation status

The JSON and YAML files parse (`bun`), and the metric names were checked against a live `/metrics` scrape in
`test/telemetry.test.ts`. The compose stack, the dashboard import and the PromQL in the alert rules have not been
run against real Docker, Grafana or Prometheus.

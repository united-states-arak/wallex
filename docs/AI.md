# The AI supervisor

## Role

Deterministic code finds a setup, applies the fee-aware gates and sizes it. Only then does an **agentic AI supervisor** review that one candidate and return one of three verdicts:

| Verdict | Meaning | Effect in code |
|---|---|---|
| `approve` | Take it as sized | Order is placed unchanged |
| `veto` | Do not take it | `setup.rejected` with reason `supervisor veto` |
| `resize` | Take it smaller, `size_mult` strictly between 0 and 1 | `qty = floor(qty * size_mult)`. Below the market minimum it is rejected |

The AI **cannot**: place or cancel orders, change prices, stops or targets, increase size, or touch the guard. `size_mult` is clamped to 0..1 in two places (`normalizeVerdict` and the strategy). A `resize` outside (0,1) is treated as `approve`.

Why code, not the AI, places orders: the order path must be deterministic, auditable and fast; a model that times out, hallucinates a price or is steered by a headline must not be able to open or enlarge a position. The worst a bad AI answer can do is skip or shrink a trade that the rules already allowed. The cost is honest too: the AI adds safety and explanations, it does not add new trades.

## Harness

- Package `libfx` 0.0.14, `createFxAgent` with a custom provider: any **OpenAI-compatible** base URL, tool use required, in-memory durability. One fresh session per review.
- Code: `src/ai/supervisor.ts`. News: `src/ai/news.ts`. Disabled / test stand-in: `src/ai/mock.ts` (always approves, reason `ai disabled`).
- If `AI_BASE_URL` is empty, the mock supervisor is used even with `--ai on`.
- Wallex tools: the daemon uses the Wallex **REST API** (markets, depth, `udf/history`, balances, orders). The Wallex **MCP** server is configured in `opencode.json` for development and inspection only. The trading loop does not call MCP.

## Tools the agent can call

| Tool | Returns |
|---|---|
| `get_setup` | The candidate: prices, RR, score, rationale, sweep and MSS summary, equity, proposed notional and % of equity, open positions, day PnL |
| `get_news_digest` | Fear and Greed value, CoinGecko trending coins, newest headlines (at most 15) with source and time. Or `unavailable` |
| `submit_verdict` | `action`, `size_mult`, `reason`. Called exactly once, last. The first call per session wins |

## News sources (`src/ai/news.ts`)

| Source | URL | Use |
|---|---|---|
| CoinDesk RSS | `coindesk.com/arc/outboundfeeds/rss/` | Headlines |
| Cointelegraph RSS | `cointelegraph.com/rss` | Headlines |
| Fear and Greed | `api.alternative.me/fng/?limit=1` | Market mood |
| CoinGecko trending | `api.coingecko.com/api/v3/search/trending` | Hot coins |

Cached for 15 minutes (60 s after a total failure, last good digest kept). 8 s timeout per request, titles cut at 160 characters. A review waits at most `min(2.5 s, timeout/3)` for the digest, then proceeds without it.

## Prompts (summary)

System prompt (`SUPERVISOR_INSTRUCTIONS`): risk supervisor of a long-only spot ICT scalper; setup is already gated and sized for a 1% stop-out loss; call `get_setup`, call `get_news_digest`, decide, call `submit_verdict` once with a reason that names concrete facts.

- **Veto** on: hack, exploit, delisting, regulatory shock, large unlock or supply event for the coin, market-wide crisis headline; extreme Fear and Greed that contradicts a long; notional above about 35% of equity while day PnL is negative; an internally inconsistent rationale.
- **Resize** on real but not decisive concern: mixed news, elevated fear or greed, several open positions, weak score, thin edge.
- **Approve** otherwise. It is told not to veto just to be cautious.

User prompt: a compact JSON brief of the same candidate (percent fields already in percent) plus a news summary.

## Fail mode and timeouts

| Setting | Default | Behaviour |
|---|---|---|
| `AI_TIMEOUT_MS` | 12000 | Whole review. On timeout, error, no verdict or bad tool input the fallback applies |
| `AI_FAIL_MODE` | `approve` | `approve`: the deterministic setup proceeds unchanged. `veto`: fail closed, skip the trade |

The fallback verdict has `source: "fallback"` and its reason says why. The API key is redacted from reasons. If the supervisor throws inside the strategy, the strategy logs `supervisor.error` and applies approve. For a stricter posture set `AI_FAIL_MODE=veto`.

## What is logged

| Event | Fields |
|---|---|
| `ai.verdict` | `symbol`, `action`, `sizeMult`, `reason`, `source` (`ai` or `fallback`), `model`, `latencyMs`, `toolCalls` |
| `setup.accepted` | Sizing, `verdict`, `verdictReason` |
| `setup.rejected` | Reason and the full verdict when vetoed |
| `order.intent` | `meta` includes the setup, sizing and verdict |

## Environment variables

| Variable | Purpose |
|---|---|
| `AI_BASE_URL` | OpenAI-compatible base URL, for example `https://host/v1`. Empty disables the AI |
| `AI_API_KEY` | Bearer key (optional for local servers) |
| `AI_MODEL` | Model name. Default `gpt-4o-mini`. Must support tool calls |
| `AI_TIMEOUT_MS` | Default 12000 |
| `AI_FAIL_MODE` | `approve` (default) or `veto` |

Manual check: `AI_BASE_URL=... AI_API_KEY=... AI_MODEL=... bun src/ai/try.ts` fetches the news digest and reviews a fake setup. `--ai on|off` on `backtest`, `shadow`, `dry` and `live` switches the supervisor (default: off for backtest, on for the others).

## Limits

- Tested with a fake OpenAI-compatible server only (`test/ai.supervisor.test.ts`). A real endpoint has not been exercised yet.
- Backtests and the walk-forward research run with the mock supervisor, so their results contain no AI effect.
- Headlines are untrusted text. Prompt injection can at most cause a veto or shrink.

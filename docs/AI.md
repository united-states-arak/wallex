# How the bot uses AI

AI plays two real roles in this project:

1. **In every trade:** an agentic AI supervisor reviews each candidate trade with live news and market sentiment before any order is sent, and can approve it, shrink it or veto it, writing its reasoning into the decision log.
2. **In building the strategy:** the trading strategy itself was produced by a tournament of autonomous AI research agents, each designing, testing and documenting a different strategy family, judged on data none of them could see.

## 1. The AI supervisor (runtime)

### Role

Deterministic code finds the breakout or washout, applies the risk guard and sizes the trade. Then an agent built on `libfx` reviews that one candidate:

| Verdict | Meaning | Effect |
|---|---|---|
| `approve` | Take it as sized | The order is placed unchanged |
| `resize` | Take it smaller, `size_mult` strictly between 0 and 1 | Quantity is multiplied and rounded down; below the market minimum the trade is skipped |
| `veto` | Do not take it | Logged as `setup.rejected` with reason `supervisor veto` and the AI's explanation |

The division of labour is deliberate: code is fast, exact and auditable for prices, sizes and orders; the AI adds judgement that price data cannot provide. A breakout caused by an exploit headline, a delisting notice or a token unlock looks like any other breakout on a chart; the AI reads the news and stops it.

### Tools the agent uses

| Tool | Returns |
|---|---|
| `get_setup` | The candidate: market, strategy, entry, stop, stop distance, rationale and evidence (breakout: level, volume ratio, trend EMA, ATR, market breadth; washout: size of the drop, share of markets falling, target and stop), equity, proposed size and share of equity, open positions, day PnL |
| `get_news_digest` | Fear and Greed index, CoinGecko trending coins and the newest headlines from CoinDesk and Cointelegraph, with source and time |
| `submit_verdict` | `action`, `size_mult`, `reason`. Called exactly once, last |

### Decision policy (system prompt summary)

- **Veto** on a hack, exploit, delisting, regulatory shock, large unlock or supply event for the coin, a market-wide crisis headline, an extreme Fear and Greed reading that contradicts a long entry, a breakout driven by a one-off headline likely to reverse, a large position while the day is already negative, or an inconsistent rationale.
- **Shrink** on real but not decisive concerns: mixed news, euphoric sentiment (late breakouts fail more often), several open positions, a thin edge.
- **Approve** otherwise, with a reason that names the concrete facts used.

### Verified with the live model

The supervisor was run end to end against the configured provider (`gpt-6-luna`):

```json
{
  "symbol": "ARBTMN",
  "action": "approve",
  "sizeMult": 1,
  "reason": "Fear & Greed is 50 (Neutral), and the headlines show no ARB-specific hack, unlock, delisting, or other adverse catalyst; the market context is mixed but not a crisis. The breakout is supported by a 1h close above the 96h high on 1.8x volume, price above a rising EMA, and 80% market breadth; notional is 20.7% of equity, day PnL is 0%, and the stop is below entry.",
  "source": "ai",
  "model": "gpt-6-luna",
  "latencyMs": 5613,
  "toolCalls": ["get_setup", "get_news_digest", "submit_verdict"]
}
```

The agent read the breakout, fetched the news and sentiment, checked the coin for adverse catalysts, weighed position size against the day's result and approved with a reason that cites each fact, in under six seconds. On an earlier sample with a larger position (38% of equity) the same model shrank the trade to 70%. Run it yourself with `bun src/ai/try.ts`.

### Provider compatibility

`src/ai/compat.ts` adapts the agent runtime to OpenAI-compatible providers automatically: reasoning models that only accept tools with `reasoning_effort: "none"` are detected from their reply and handled, and content-filter stream chunks are filtered out. Any OpenAI-compatible endpoint with tool calling works by setting `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL`.

### Safety of the AI path

| Property | How |
|---|---|
| Cannot create or enlarge risk | The AI has no order tool. `size_mult` is clamped to 0..1 in two places. A `resize` outside (0, 1) counts as `approve` |
| Bounded time | The whole review is limited to `AI_TIMEOUT_MS` (12 s); the news digest is awaited at most 2.5 s |
| Defined failure behaviour | On timeout or error a fallback verdict applies (`AI_FAIL_MODE`: `approve` keeps the rule-based trade, `veto` skips it), labelled `source: "fallback"` with the cause |
| Prompt injection | Headlines are sanitised (control characters, bidirectional overrides, markup removed, 160 characters). Because the AI can only veto or shrink, a malicious headline can at most skip or reduce a trade |
| Secrets | The API key never enters a prompt and is masked in every logged reason |

### What is logged

| Event | Fields |
|---|---|
| `ai.verdict` | `symbol`, `action`, `sizeMult`, `reason`, `source` (`ai` or `fallback`), `model`, `latencyMs`, `toolCalls` |
| `setup.accepted` | Size, risk, rationale, evidence, `verdict`, `verdictReason` |
| `setup.rejected` | Reason and the full verdict when vetoed |

### News sources

| Source | Use |
|---|---|
| CoinDesk RSS, Cointelegraph RSS | Headlines |
| alternative.me Fear and Greed | Market mood |
| CoinGecko trending | Coins with unusual attention |

Cached for 15 minutes, each request limited to 8 s and 1 MB, the last good digest kept if all sources fail.

### Configuration

| Variable | Purpose |
|---|---|
| `AI_BASE_URL` | OpenAI-compatible base URL (https, or a local model server) |
| `AI_API_KEY` | Bearer key |
| `AI_MODEL` | Model name; must support tool calls |
| `AI_TIMEOUT_MS` | Default 12000 |
| `AI_FAIL_MODE` | `approve` (default) or `veto` |

The supervisor is on by default in shadow, dry and live, and replaced by a deterministic stand-in in backtests (`--ai on|off` overrides), so backtests are fast and reproducible.

## 2. AI agents in strategy research

The strategy was not hand-picked. Four autonomous AI research agents each received the same data, rules and cost model and built one strategy family: trend breakout, cross-sectional rotation, mean reversion and an improved ICT model. Each agent studied the data, designed and tuned its strategy on the first 120 days only, validated it on sub-periods, and wrote a report with every parameter, every variant tried and its own weaknesses. The judge then ran every strategy once on the final 60 days, which no agent had seen.

The breakout strategy won on that unseen window with the highest profit factor, a drawdown under 8% and the most consistent edge over passive market exposure; production pairs it with the washout bounce in the `combo` strategy. Full results are in [RESEARCH.md](RESEARCH.md); each agent's report is in `arena/<name>/NOTES.md`.

A separate AI agent verified the live system before the run: it compared every Wallex API response with the code's parsers, placed small real buy and sell orders through the production adapter, measured latency and confirmed that the orders spend the challenge capital. Its findings were fixed in the code (see [WALLEX.md](WALLEX.md)).

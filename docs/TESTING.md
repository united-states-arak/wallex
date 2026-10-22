# Testing and reproducing results

All commands run from the repo root with Bun. Public market data needs no key. Candles are cached under `data/candles/<SYMBOL>/<day>.json` (complete UTC days only), so a second run over the same window reads the same data.

## 1. Unit tests

```bash
bun run test        # bun test, no network, no key
bun run typecheck   # tsc --noEmit
```

| File | Covers |
|---|---|
| `ict.primitives`, `ict.detect`, `ict.scan` | Swings, FVG, displacement, levels, sweep, MSS, continuation, **no-lookahead** tests |
| `ict-strategy` | Gates, entry, TPs, break-even, stop, time stop, restore from state |
| `size`, `guard` | Sizing formula, cap, day halt, drawdown kill, profit lock, loss pause, `STOP` file |
| `ai.supervisor`, `ai.news` | Fake OpenAI-compatible server, fallback, timeout, RSS parsing |
| `paper`, `pullout`, `daemon` | Paper fills and fees, flatten to TMN, schedule, restart, error survival |
| `universe`, `research` | Auto universe filter, walk-forward metrics and pick rule |
| `telemetry` | Metric names, labels and the `/metrics` scrape |

## 2. Backtest

```bash
bun run backtest --strategy ict --symbols auto --days 7
bun run backtest --strategy ict --symbols PEPETMN,PUMPTMN,DOGETMN --from 2026-10-15T00:00:00Z --to 2026-10-22T00:00:00Z
```

- `--strategy` defaults to `ict` (`--strategy noop` places no orders). `--ai` defaults to off (mock approves). `--days` defaults to `research.defaultDays` (7).
- `--symbols auto` ranks TMN markets by 24h range times 24h volume **today**, so it looks ahead for old windows. For a clean test give explicit symbols and `--from` / `--to`.
- Output: per-symbol bar counts, a summary (`returnPct`, `fills`, `volumeTmn`, `feesTmn`, `maxDrawdownPct`) and a log in `logs/backtest-*.jsonl`. The summary is also the `backtest.summary` event.
- Same input, same code, same result: no randomness is used.
- Open positions at the end are liquidated by the harness through `pullout`, at taker fees, and counted in the return but not as trades.

## 3. Walk-forward research

```bash
bun run research -- --symbols auto --days 7            # options: --split 0.57 --risk 0.01 --to ISO --grid grid.json
```

Fetches the window plus 12 h warm-up, trains 8 parameter variants on the first 57% (about 4 of 7 days), picks one using **train numbers only** (best return with at least 5 train trades, else lowest drawdown), then reports train and test side by side. Writes `docs/RESEARCH.md` (overwritten) and `logs/research-*.json`. Latest result: the picked variant had 0 test trades. The full table is in [RESEARCH.md](RESEARCH.md).

Setup counting and a simple outcome walk (TP1 only, stop wins ties, cost formula slightly different from the strategy gate): `bun src/ict/scan.ts --symbols PEPETMN,PUMPTMN --days 7 --walk [--model sweep|continuation|both] [--param key=value]`.

## 4. Shadow test (live data, no orders)

```bash
bun run shadow --strategy ict --symbols auto --minutes 1440
```

Polls Wallex every 20 s, runs the real strategy and AI against a `PaperExchange` seeded with `START_TMN`. Logs `shadow.equity` every cycle plus all strategy events. Prints final equity and fill count. Use `--ai off` to compare without the supervisor.

## 5. Dry run (real validation, nothing sent)

```bash
bun run dry --strategy ict --minutes 60          # add --once for a single pass
bun run live --dry --run-end 2026-10-23T12:00:00Z   # full daemon, dry exchange
```

`dry` first validates a probe BUY priced at half the bid (`dry.would_send` event with the exact request body), then runs the strategy. Each order is checked for blocked market, step size, minimum order and balance, and logged as `dry.would_send` or `dry.rejected`. It never fills, so it tests wiring, not performance. With a key it reads real balances.

## 6. Paper daemon

`bun run live --paper --run-end <ISO>` runs the whole daemon (state files, cutoff, flatten) on the paper exchange. Use it to rehearse the 24 h procedure.

## 7. Simulator assumptions (`src/exchange/paper.ts`)

| Topic | Assumption |
|---|---|
| Fees | 0.25% maker on resting limit fills, 0.3% taker on marketable orders, both charged in TMN |
| Quotes | Candle close plus or minus half of `PAPER_SPREAD_BPS` (10 bps total) |
| Limit fills | Buy fills if the bar low is at least one tick below the limit, sell if the bar high is one tick above. Filled in full at the limit price, no queue, no partial fills |
| Order timing | An order placed on bar `i` is eligible from bar `i+1` |
| Marketable limits | Fill at the touch (bid or ask), whatever the order size |
| MARKET orders | Touch plus `PAPER_SLIPPAGE_BPS` (10 bps). The strategy itself uses limit orders |
| Stops in backtest | Checked once per closed 1m bar (no 5 s ticks). The exit fills at that bar's close-based bid, not at the stop price |
| TP and stop in the same bar | The resting TP fills first. This is optimistic |
| Equity | TMN plus holdings at the bid, includes unrealised PnL |

## 8. Known limits

- Tiny samples: a week gives a handful of trades. One trade flips the sign.
- 1m candles only, no order-book depth, no partial fills, no latency model.
- Backtest and research use the mock AI. Shadow and dry use the real AI only if `AI_BASE_URL` is set.
- `--symbols auto` is look-ahead for historical windows.
- Private Wallex endpoint shapes and real fills are unverified (see COMPLIANCE.md).
- Results come from one short market regime.

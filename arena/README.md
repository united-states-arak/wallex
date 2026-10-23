# Strategy arena

Several strategies compete on the same data, costs and risk rules. The judge ranks them on a **held-out 60-day window that the contestants never see**, not on the window they tune on.

## What is fixed

| Item | Value |
|---|---|
| Data | Wallex 1m candles, 2026-04-25 to 2026-10-22, cached in `data/candles/<SYMBOL>/` |
| Train window (yours) | 2026-04-25 to 2026-08-23 (120 days). `--window train` |
| Test window (judge only) | 2026-08-23 to 2026-10-22 (60 days). Do not run it, read it, or load candles after 2026-08-23 |
| Markets | `PEPETMN PUMPTMN USOONTMN BNBTMN ETHTMN XRPTMN ARBTMN DOGETMN ADATMN STMN SOLTMN APETMN TRXTMN LTCTMN AAVETMN`. Spot, long only, TMN pairs |
| Start equity | 5,000,000 TMN |
| Fees | maker 0.25%, taker 0.30% |
| Spread / slippage | 30 bps spread around each close (harsher than production's 10 bps default), 10 bps slippage on taker fills |
| Fills | Order placed on bar i can fill only from bar i+1. A limit BUY fills only if price trades through it by one tick (maker fee). A marketable limit fills at the ask or bid (taker fee) |
| Orders | `LIMIT` only (market orders are disabled on Wallex). A stop is not an exchange order: the strategy watches the bar and sells at the bid |
| Rules (enforced, violations are rejected and counted) | At most 2 open positions plus pending entries. One position at most 50% of equity |
| End of window | Anything still held is sold at the bid (counted in the result) |

## How the winner is chosen

The judge runs each strategy once on the held-out test window and compares it with its train result. The ranking weighs, in this order:

- profitable on both train and test (a strategy that earns on train and fails on test is overfit)
- **edge over passive exposure** in both windows: return minus average exposure times the basket's buy-and-hold return, so market drift in TMN is not mistaken for skill (`avgExposurePct` is in the output)
- max drawdown, at most 15%
- profit factor on the test window
- zero arena rule violations
- trade count across both windows, reported so that results resting on a handful of trades are visible

The incumbent ICT strategy is in the race too. If nothing beats it on the test window, we keep it. Final results: [docs/RESEARCH.md](../docs/RESEARCH.md) (the trend breakout won; production runs it together with the washout bounce as the `combo` strategy, `arena/strategies/production-combo.ts`).

## How to run

```bash
bun arena/run.ts --strategy arena/<you>/strategy.ts                 # full train window, 15 markets
bun arena/run.ts --strategy arena/<you>/strategy.ts --days 20       # last 20 days of train, faster
bun arena/run.ts --strategy arena/<you>/strategy.ts --span 0:80     # train days 0 to 80 (fit)
bun arena/run.ts --strategy arena/<you>/strategy.ts --span 80:120   # train days 80 to 120 (validate)
bun arena/run.ts --strategy arena/<you>/strategy.ts --symbols PEPETMN,DOGETMN --json
```

Output: `returnPct`, `maxDrawdownPct`, `roundTrips`, `tripsPerDay`, `winRatePct`, `avgTripPct`, `profitFactor`, `sharpeDaily`, fees, `ruleViolations`, per-symbol P&L.

## Strategy contract

`arena/<you>/strategy.ts` default-exports `create(ctx: { meta, startTmn, symbols }) => Strategy` (see `src/types.ts`). `onBar({ symbol, bars, ex })` is called once per closed 1m bar per symbol, oldest first, `bars` is the live rolling history (about 3000 bars, do not mutate it). It may place orders through `ex` or return them.

You may use `arena/kit.ts` (sizing, limit entry, take-profit, stop, time stop, trailing hook) so only your signal differs, or write your own order handling. `arena/strategies/example-sma.ts` is a template. `arena/strategies/baseline-ict.ts` is the incumbent, the strategy to beat.

Helpers: `aggregate(bars, minutes, nowSec)` in `src/data/candles.ts` (pass `bars.at(-1).t + 60` so the still-forming bucket is dropped), `floorTo` and `roundTo` in `src/exchange/validate.ts`.

## Honesty rules

- **No lookahead.** Use only the bars you are given. Closed aggregate bars only. No data after the current bar.
- **Deterministic, no network, no randomness** (seed it if you need it).
- **Speed.** `onBar` runs about 2.6 million times on the train window. Do the real work only when a signal bar closes and keep indicators incremental. A full train run must finish in under 15 minutes.
- **Do not overfit.** Few parameters, chosen on train days 0:80 and checked on 80:120. Prefer settings where neighbours also work. Count how many variants you tried and report it. A result that only works for one exact setting is a failure.
- **Stay in your lane.** Edit only inside `arena/<you>/`. Do not change `src/`, `config/`, `arena/run.ts`, `arena/kit.ts` or other contestants' folders.
- **Report truthfully**, including a losing result. A strategy that does not beat doing nothing is a valid finding.

## What to hand back

1. `arena/<you>/strategy.ts`
2. `arena/<you>/NOTES.md`: the idea in plain words, entry, exit, sizing, every parameter and why, how many variants you tried, results on `0:80`, `80:120` and the full train window, per-symbol P&L, known weaknesses.
3. A short final message with the full-train numbers from `--json`.

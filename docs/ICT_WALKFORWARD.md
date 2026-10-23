# Walk-forward research of the ICT model (historical)

> **Historical document.** This is an early 7-day walk-forward study of the alternative ICT model ([ICT_MODEL.md](ICT_MODEL.md)), produced by `bun run research` (`src/research/walk.ts`). It is not evidence for the production strategy: the default `combo` strategy was selected in a 180-day strategy tournament with a held-out window, see [RESEARCH.md](RESEARCH.md).

Generated 2026-10-22T19:14:00.217Z by:

`bun run research -- --symbols auto --days 7`

- Symbols (12): PUMPTMN, PEPETMN, BTCTMN, USOONTMN, ETHTMN, ARBTMN, DOGETMN, XRPTMN, SOLTMN, STMN, APETMN, UNITMN
- Train: 2026-10-15T19:09Z to 2026-10-19T18:54Z. Test: 2026-10-19T18:54Z to 2026-10-22T19:09Z (split 0.57).
- Start equity 5000000 TMN, risk per trade 1%, mock supervisor, guard without kill file or state.
- Fees: maker 0.25%, taker 0.3%. Fills need price to trade through the limit by one tick. Entry on bar i fills from bar i+1.
- Pick rule: best train return with at least 5 train trades, else lowest train drawdown. Picked: **strict-baseline** (basis: drawdown).
- Picked entry on TEST: 0 trades, return 0.00%, maxDD 0.00%, avgR 0.00.

| entry | win | trades | win% | avgR | exp %/trade | ret % | maxDD % | fees | volume | setups acc/rej | exec rej |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **strict-baseline** (picked) | train | 0 | 0 | 0.00 | 0.000 | 0.00 | 0.00 | 0k | 0k | 1/5 | 0 |
| **strict-baseline** (picked) | test | 0 | 0 | 0.00 | 0.000 | 0.00 | 0.00 | 0k | 0k | 1/6 | 0 |
| rr1.5 | train | 0 | 0 | 0.00 | 0.000 | 0.00 | 0.00 | 0k | 0k | 1/5 | 0 |
| rr1.5 | test | 2 | 50 | 0.71 | 0.578 | 1.14 | 1.12 | 23k | 8.87M | 4/4 | 1 |
| rr1.3 | train | 1 | 0 | -0.51 | -0.345 | -0.34 | 0.88 | 14k | 4.95M | 2/3 | 1 |
| rr1.3 | test | 2 | 50 | 0.28 | 0.286 | 0.55 | 1.76 | 25k | 9.69M | 4/2 | 0 |
| both-models-rr1.5 | train | 0 | 0 | 0.00 | 0.000 | 0.00 | 0.00 | 0k | 0k | 1/5 | 0 |
| both-models-rr1.5 | test | 2 | 50 | 0.71 | 0.578 | 1.14 | 1.12 | 23k | 8.87M | 4/4 | 1 |
| sweep-only-rr1.5 | train | 0 | 0 | 0.00 | 0.000 | 0.00 | 0.00 | 0k | 0k | 1/4 | 0 |
| sweep-only-rr1.5 | test | 2 | 50 | 0.71 | 0.578 | 1.14 | 1.12 | 23k | 8.87M | 4/3 | 1 |
| cont-only-rr1.5 | train | 0 | 0 | 0.00 | 0.000 | 0.00 | 0.00 | 0k | 0k | 0/1 | 0 |
| cont-only-rr1.5 | test | 0 | 0 | 0.00 | 0.000 | 0.00 | 0.00 | 0k | 0k | 1/1 | 0 |
| minStop0.007-rr1.5 | train | 1 | 0 | -1.80 | -0.740 | -0.73 | 1.23 | 14k | 4.98M | 2/8 | 0 |
| minStop0.007-rr1.5 | test | 3 | 33 | -0.13 | 0.168 | 0.47 | 1.12 | 37k | 13.91M | 7/9 | 1 |
| minStop0.007-rr1.3 | train | 2 | 0 | -1.15 | -0.542 | -1.07 | 1.61 | 27k | 9.91M | 4/6 | 1 |
| minStop0.007-rr1.3 | test | 4 | 50 | 0.36 | 0.222 | 0.86 | 1.76 | 52k | 19.75M | 8/5 | 0 |

Columns: exec rej counts rejected exit or take-profit orders; anything above 0 means a position could not be managed as designed (for example a paper-exchange balance error), so that run's return is not trustworthy. Trades are round trips (strategy `exit` events); avgR is net PnL over planned risk qty*(entry-stop); exp is mean net PnL per trade as % of equity at entry; ret and maxDD are whole-window equity figures including fees.

## Caveats

This is a short sample (7 days, one market regime) on a handful of symbols, so every number here has wide error bars; with only a few trades per window, a single trade can flip the sign. Picking the best of 8 variants on train and seeing it do well on test is weak evidence, and the table is shown in full so that selection noise and train/test gaps are visible. `--symbols auto` ranks symbols using today's 24h stats, which look ahead relative to the historical window and favour coins that have recently been active. Fills are simulated from 1m candles, so queue position, partial fills and real spread are not modelled beyond the paper exchange rules. Positions still open when a window ends are liquidated by the harness: they move return but are not counted as trades. The test window gets 12h of earlier bars as detector context (no orders placed), and the grid parameters were chosen by hand before this run. None of this is a forecast of live performance.

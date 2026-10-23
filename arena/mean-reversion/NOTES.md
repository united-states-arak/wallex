# mean-reversion: washout bounce

> This is the contestant's research report on the train window. Production runs this model as `src/strategy/washout.ts` inside the default `combo` strategy, with the risk per trade set to 1% instead of the 2% used here (see [docs/RESEARCH.md](../../docs/RESEARCH.md) section 3).

## Idea
Thin TMN altcoin markets overshoot on fast drops and partly retrace within hours. A study on train days 0:80 only
(`study.ts`, 15m bars, forward return 16 bars after the signal close, before costs) showed the rebound grows with the size
of the preceding 1h drop, and does so across symbols and in both halves of the sample:

| 1h return at signal | n | avg fwd 4h | avg max-up in 4h |
|---|---|---|---|
| <= -2% | 3161 | +0.76% | 2.5% |
| <= -3% | 1146 | +1.18% | 3.1% |
| <= -4% | 478 | +1.53% | 3.8% |
| <= -5% | 201 | +2.11% | 4.1% |

Mild oversold (z-score below -2, RSI < 30) gave only about +0.4 to +0.6%, which is less than the ~0.8% round trip cost, so
it is not tradable. A "trend is up" filter made things worse: dips below the 4-day average rebound at least as much. I did not use it.

## Rules
- Signal bars: 15m, built incrementally from 1m, closed bars only. Evaluated once, when a 15m bar closes.
- Entry: 1h return (4 bars) <= -3.5%. Buy at the ask (taker, `taker: true` in the kit). Position size comes from the kit
  risk rule (2% equity at the stop), so with a 6% stop it is about 30% of equity.
- Exit: resting maker limit sell at entry +4% (the kit's `tp`). Stop at entry -6% (checked on 1m bars, sells at the bid).
  Time stop after 32 signal bars (8h), sells at the bid.
- Crash guard: skip entry when more than 50% of the basket has a 1h return below -2% (market-wide fall).
  This is a weak filter: it removes about 4 of 200 trades and moved 0:80 from +40.5% to +47.6%. Do not count on it.

## Parameters (all in `P`)
| name | value | why |
|---|---|---|
| tf | 15 | 5m and 30m also worked (see below) |
| lb | 60 min | 1h drop; 30m, 2h and 4h lookbacks with matching thresholds also positive |
| drop | 3.5% | trade count versus quality, 3% to 5% all positive |
| tpPct | 4% | must clear ~0.8% costs by a wide margin; 3.5% to 4.5% all positive |
| stopPct | 6% | rarely hit, it mostly sets the size; 4% to 8% positive |
| holdBars | 32 (8h) | 24 to 48 positive |
| breadthDrop / breadthMax | 2% / 50% | crash guard, see above |
| risk | 2% | kit maximum |

## What did not work
- Resting limit buys below the market (offset 0 to 0.5%): fill adversity. They fill when the knife keeps falling and miss
  the V-bounces. Win rate 47% to 57%, net negative on 0:80. Paying the taker fee and spread to enter at once was much better.
- ATR-scaled stops of 1 to 2 ATR and z-score/RSI-only triggers: lost 15% to 60% on 0:80. Tight stops get hit by noise and the edge is smaller than costs.
- Adding RSI <= 25 to 35: higher average trade but half the trades, and no better on 80:120.

## Variants tried
About 50 parameter sets, almost all on `--span 0:80` and `80:120` (never the test window), 1 full-train run for the final number. The final
neighbourhood (drop 3% to 5%, lb 30m to 4h, tp 3.5% to 4.5%, stop 4% to 8%, hold 24 to 48, tf 5/15/30) was positive on both spans in every
combination I ran, ranging +3% to +48% on 0:80 and +5% to +14% on 80:120. I chose the centre of the plateau, not the best cell.

## Results (train only)
| span | return | max DD | trips | trips/day | win | avg trip | PF | Sharpe |
|---|---|---|---|---|---|---|---|---|
| 0:80 | +45.13% | 10.10% | 202 | 2.52 | 63.9% | 0.64% | 1.60 | 5.39 |
| 80:120 | +8.35% | 7.14% | 36 | 0.90 | 69.4% | 0.77% | 1.84 | 3.40 |
| full train | +57.23% | 10.10% | 238 | 1.98 | 64.7% | 0.66% | 1.64 | 4.77 |

Full train per symbol (trips, P&L TMN): APE 67/+668k, ARB 16/+536k, STMN 32/+512k, PUMP 18/+376k, AAVE 22/+309k, LTC 8/+278k,
PEPE 4/+173k, TRX 5/+129k, XRP 2/+111k, DOGE 3/-14k, ETH 1/-28k, SOL 1/-37k, ADA 22/-52k, USOON 37/-100k. BNB: no trades.
Fees paid 2.46M TMN on 854M volume. Zero rule violations. A full train run takes about 4 seconds.

## Known weaknesses
- Activity is regime dependent: 2.5 trades/day in days 0:80, 0.9 per day in 80:120. If the test window is calm there may be few trades
  (judge needs 20 in 60 days; 80:120 pace would give about 54).
- Return in 80:120 (+8%) is far lower than in 0:80 (+45%). Per-trade quality held up (avg 0.77% vs 0.64%), the difference is the number of trades.
- The edge is a bounce after panic sells. A real trending crash (ex: a 15% leg down over days) would produce several stops in a row. The 6% stop caps the loss per
  trade at about 2% of equity, and the max drawdown on train was 10%.
- Gains concentrate in small, volatile coins (APE, ARB, S, PUMP). Majors (BNB, ETH, SOL) almost never trigger.
- Entries at the ask rely on the arena's 30 bps spread assumption; the TP maker fill assumes a one-tick touch fills at the limit (no queue).
- When several markets trigger on the same bar the kit takes whichever is processed first (alphabetical), not the deepest drop.

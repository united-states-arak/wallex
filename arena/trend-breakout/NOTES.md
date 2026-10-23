# trend-breakout

> Tournament winner. This is the contestant's research report on the train window; the held-out result and the production version (`src/strategy/breakout/`, run with the washout model as the default `combo`) are in [docs/RESEARCH.md](../../docs/RESEARCH.md). Production preloads 8 days of history, so the warm-up gap noted below does not apply to the bot.

Long-only 1h Donchian breakout, taken only when the whole basket is in an uptrend, with a wide ATR initial stop and a wide chandelier trail so winners run. Not an ICT strategy.

## Idea in plain words
The 0:80 train window was a bear/chop market for this basket: most coins lost 5-35%, and gross forward returns after naive breakouts were about zero or negative (event study, research2.ts). A breakout rule on its own has no edge here, and 1.0% round-trip cost kills it. Two things changed that:
1. **Regime gate**: only trade when at least 70% of the 15 markets have a 1h close above their own EMA(168h). Basket forward returns are clearly better when the basket is above its 7-day EMA than below it (research3.ts). When the gate is shut the strategy sits flat.
2. **Let winners run**: stops and trails of several hourly ATRs. Win rate is about 50%, but the average winner is much larger than the average loser. Narrow trails (2.5-3 ATR) lost money in every test.

## Rules (all on closed 1h bars built incrementally from 1m)
- **Entry** at the first 1m bar after an hourly close, taker (marketable limit at the ask), when all hold:
  - the 1h close is above the highest high of the previous N=96 hours (4-day breakout)
  - the 1h close is above EMA(96) and the EMA is rising
  - the close is no more than 3 ATR above the breakout level (do not chase)
  - the breakout hour's volume is above 1.5x the average of the previous 24 hours
  - the breadth gate above (share of markets with close above EMA(168) >= 0.7, needs >= 96 hourly bars seen per market)
- **Initial stop**: entry - 4 x ATR(14, 1h).
- **Trail**: highest 1m high since entry - 8 x ATR(14, 1h). It only moves up. The kit sells at the bid when a 1m low touches the stop.
- **Time stop**: 336 hours (never hit in train).
- **Sizing**: kit risk of 1% of equity at the stop, capped at 50% of equity per position. With a stop of about 4 ATR this usually means roughly 20-40% of equity. Max 2 positions.

## Parameters (9, all chosen coarsely)
| Param | Value | Why |
|---|---|---|
| N | 96 h | 4-day high, meaningful breakout. Plateau 72-120 (48 also works, 168 is bad) |
| EMA | 96 h | coin trend filter (not tuned) |
| ATR | 14 | standard |
| K | 4 | initial stop. 3-5 all positive with M=8 |
| M | 8 | trail. This is the only sensitive parameter: 3-5 loses, 6 is marginal, 8-12 is good |
| VOL | 1.5 | volume confirmation. 1.0-2.0 fine. Off (0) is worse and less stable |
| CHASE | 3 | max extension. 2-5 fine |
| MKT / MEMA | 0.7 / 168 | breadth gate. 0.6-0.8 fine, 0.5 is worse |
| RISK | 1% | default, higher only scales risk |

## Variants tried
About 39 full configurations were each backtested on 0:80 and 80:120 (parameter neighbours for N, K, M, VOL, CHASE, MKT, MEMA, RISK, MAXH). Before that, about 25 event-study variants (breakout length, EMA, volume, compression, market filter, cross-sectional momentum, regime episodes) in research*.ts, restricted to train days 0:80 by code. The 80:120 span was used to check neighbours, not to pick among them blindly, but it was looked at many times, so it is not a clean holdout any more. Full-train runs: 1 (the final config) plus a few 20:80, 30:90, 40:120, 60:120 offset checks.
Earlier versions with no market gate and a 2.5/3 ATR stop/trail lost 40% on 0:80.

## Results (train, final config, arena costs)
| Window | Return % | Max DD % | Round trips | Win % | Avg trip % | PF |
|---|---|---|---|---|---|---|
| Full 0:120 | +20.94 | 7.65 | 23 | 52.2 | +3.64 | 2.93 |
| 0:80 (fit) | +5.84 | 6.28 | 13 | 53.8 | +1.92 | 2.05 |
| 80:120 (validate) | +10.78 | 7.59 | 9 | 44.4 | +4.82 | 3.25 |
| 20:80 | +0.06 | 2.74 | 5 | 60 | -0.61 | 1.08 |
| 30:90 | +3.03 | 4.23 | 9 | 55.6 | +1.73 | 2.30 |
| 40:120 | +14.33 | 7.65 | 15 | 53.3 | +3.71 | 3.50 |
| 60:120 | +17.47 | 7.59 | 18 | 50 | +4.00 | 3.35 |

Sharpe (daily, full) 2.48. Zero rule violations. A full train run takes about 4 seconds.

Per-symbol P&L (TMN, full train): ARB +493k, LTC +237k, BNB +213k, TRX +211k, PUMP +109k, USOON +106k, STMN -51k, DOGE -56k, PEPE -57k, ADA -38k, APE -63k, XRP -56k. ETH, SOL and AAVE never traded. Without ARB the return is still around +11%.

## Known weaknesses
- **Few trades**: about 0.19 per day, so roughly 11 expected in a 60-day window. The judge needs 20 or more, so it may fail to qualify unless the test window is trending. Lowering the thresholds to get more trades made results worse in train.
- **Regime dependent**: nearly all profit comes from the two up-legs (days 0-20 and days 85-120). From day 20 to 80 it is flat (+0.06%, 5 trades). It protects capital in a bear market but earns nothing there. If the test window is a persistent downtrend the expected result is about 0 minus small whipsaw losses. If it is a strong uptrend the result should be good.
- **Small sample**: 23 trades, 4 or 5 big winners make the profit. The confidence interval on the true edge is wide.
- **Trail width is the sensitive knob** (M below 6 loses). Larger M means giving back more of each winner in a reversal.
- The slow EMA(168) and the 96-bar minimum need about 4 days of history. The arena only supplies 3000 1m bars (50 h) plus whatever the strategy has accumulated, so at the start of any run there are about 2 days of no trading.
- Taker entries pay the 30 bps spread plus fees. No limit-entry variant was tried.
- Validation span 80:120 was inspected many times when comparing neighbours, so it is only weakly out-of-sample.

## Files
- `strategy.ts`: the strategy
- `research.ts`, `research2.ts` (breakout event study), `research3.ts` (regime and cross-sectional momentum), `research4.ts` (basket EMA episodes): offline studies, hard-capped at train day 80 in the loader. They are not needed to run the strategy.

# rotation-momentum

## Idea
The 15 markets move together (the same TMN/USDT wave drives all of them), so most of the available edge is the *basket's* trend, not which coin is picked. The strategy is long only and slow:
be invested only while the basket trades above its own trend, hold the two relatively strongest coins, and sit in TMN otherwise. Turnover is low on purpose because a round trip costs about 0.9% here (taker fee 0.3% x2, plus 15 bps half-spread x2).

## Rules (all on closed 1m bars, UTC hour boundaries)
- Own state only: a per-symbol hourly close array (last close of each hour, forward-filled), built incrementally in `onBar`; the first call per symbol bootstraps it from the `bars` history. No future bars are used. The decision runs on the first bar after minute 0 of every 12th hour (hour index % 12 == 0), using each coin's latest close.
- Per coin: `dev = ln(price / SMA of last 96 hourly closes)`, `score = mean(24h return, 72h return)`.
- Regime ON when the mean `dev` across the basket is > 0 (basket above its 4-day average).
- Entry (only at a decision, only when the regime is ON): take the top 2 coins by score, skipping a coin if score <= 0, its own dev <= 0, it is in an 8h cooldown after a sale, or it is already held. Marketable limit at the ask, taker fill. Size 30% of equity per position (cap is 50%).
- Exit: (a) regime OFF at a decision: sell everything; (b) trailing stop 15% below the highest high since entry, checked on every 1m bar of the held coin (sell as a marketable limit at the bid, retried at wider prices if it does not fill). There is no rank-based exit: rank exits and coin-level trend exits both raised turnover and lost money in the tests.
- Warm-up: the 96h average needs 4 days of history, so no trading in the first 4 days of any run (the arena only hands over about 2 days of bars at the start).

## Parameters (7)
| name | value | why |
|---|---|---|
| decision step | 12h | 4h to 8h whipsaws badly, 24h is as good or better (see sensitivity) |
| coins held | 2 | the arena maximum; single coin variant (K=1) returned only +1% on 0:80 with DD 12.7% (older version of the rules) |
| score lookbacks | 24h and 72h | one day and three days; 24/48 and 36/72 behave the same |
| trend SMA | 96h | middle of a plateau 84h to 120h |
| trailing stop | 15% | 12% and 18% neighbours are close (volatile coins, tighter stops are noise) |
| size | 30% per position | 49% gave 20 to 25% drawdowns; 30% brings DD near the 15% limit |
| cooldown | 8h | stops immediate re-buy of a coin just stopped out |

## Results (train only)
| window | return % | max DD % | trips | win % | PF | Sharpe |
|---|---|---|---|---|---|---|
| 0:80 (fit) | +4.17 | 16.71 | 21 | 33.3 | 1.29 | 0.87 |
| 80:120 (validate) | +6.23 | 14.98 | 18 | 27.8 | 1.43 | 0.95 |
| full 120 days | +21.37 | 16.71 | 39 | 33.3 | 1.71 | 1.65 |

Zero rule violations. A full train run takes about 2 to 3 seconds of loop time.
(The full window is larger than the sum of the two spans because the spans each lose the first 4 days to warm-up and the 80:120 span starts flat.)

Full-window per-symbol P&L (TMN): USOON +478,555, AAVE +523,457, PUMP +347,868, APE +66,407, ARB +20,486, TRX +7,508, SOL -10,407, ETH -19,299, PEPE -55,863, ADA -58,840, STMN -94,078, BNB -137,252.

## Research findings (train days 0:80 only)
- Basket time-series momentum is real but small: after the basket was up over the last 72h/120h, the next 48h averaged +0.55%/+0.76%; after down, -0.97%/-1.26%.
- Cross-sectional momentum is not: the top-2 coins by 6h to 72h return *underperformed* the basket on average (short horizon reversal, spiky PUMP/PEPE), only a 24h score on top of an up regime was mildly positive. A pure "rotate to the strongest every 4h" version lost 66% on 0:80. Ranking mostly adds noise; as an ablation, picking the *weakest* coins instead scored worse on both spans (+3.6/-1.7 vs +6.7/+9.6 in the version tested then), so ranking by strength is weakly useful, but that is all.
- Faster decisions or exit checks (every 2h, 4h, 6h, 8h) destroy the edge because costs eat 0.9% per trip.

## Variants tried
About 75 span-level configurations (mostly 0:80 first, then 80:120 for the ones that looked good) and 3 full-train runs. I looked at 80:120 for neighbour checks, so it is only a weak out-of-sample test: some of the neighbour choice (SMA 96 as plateau centre) was informed by seeing both spans.

## Sensitivity (default except one change; 0:80 / 80:120 return %)
- SMA 72: -9.1 / +18.9. SMA 84: +8.1 / +11.2. SMA 96: +4.2 / +6.2. SMA 108: +12.9 / +5.8. SMA 120: +1.7 / +9.0. SMA 144: -4.4 / +3.9.
- Step 6h: -10.1 / +4.6. Step 12h: base. Step 24h: -7.3 / +22.0.
- Trail 12%: +0.7 / +8.9 (SMA 120). Trail 18%: same as 15%.
- Lookbacks 24/48: +3.1 / +8.2. 36/72: +3.1 / +9.7 (SMA 120).

## Known weaknesses
- Not robust. It works only inside an SMA 84h to 120h and 12h/24h step plateau and flips sign outside it. The 0:80 return is small relative to its drawdown.
- Profits are concentrated in a few large movers (AAVE, PUMP, USOON); strip those and the strategy is flat to negative. PUMP alone rose 3.5x in the last 40 train days.
- Long-only in a market that went -40% in the middle of the window: the regime filter lags and the trail is wide, so the max drawdown (16.7%) exceeds the arena's 15% limit. Lowering size reduces DD and return proportionally.
- Low trade count: 39 trips in 120 days is about 19 per 60 days, below the judge's 20-trip minimum, and it cannot be raised without adding churn that loses money.
- Only 2 regime-switch episodes of each kind per month, so the sample for the regime rule is tiny. 80:120 was a strong up-trend, which flatters any long-only trend follower.
- 4 days of warm-up at the start of any window.
- The 8h cooldown and the regime step are unproven constants.

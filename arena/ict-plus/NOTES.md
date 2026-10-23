# ict-plus

## Finding

On this train window the incumbent's setups carry almost no directional edge. The cost of one round trip (about 0.5% fees plus spread, about 0.7% when stopped out) is as large as the typical 1% to 1.5% structural stop. Mean price drift after the fill was about 0 for every horizon from 5 minutes to 8 hours (`drift.ts`). Every exit variant I simulated on the detector's own setups lost about one round-trip cost per trade (`exits.ts`): partial TP, 1R to 2R targets, time stops, other entry prices.

The only change that helped consistently was to **keep the entries and replace the risk shape**: a fixed 5% stop and a single TP at 2.5x that distance. That dilutes the fixed cost per trade (position size falls with the wider stop, so each trade risks the same 1.5% of equity). It is risk-shape engineering, not a new edge. The result is about flat to mildly positive, against an incumbent that is clearly negative.

## Strategy (`strategy.ts`)

- **Signal**: the unmodified incumbent `findSetup` (sweep + MSS + FVG, and continuation), called only when a 5m bar has just closed. The detector input only changes then, and the full train run takes about 90 s instead of 13 min. Each setup key (symbol, sweep time, FVG time) trades once.
- **Entry**: limit BUY at the detector's entry (FVG CE or OTE overlap). Cancelled after 60 one-minute bars (incumbent: 180) or if a 1m bar closes under the stop. The kit does this.
- **Stop**: `entry * (1 - 5%)` (the detector's tighter structural stop is discarded). Checked on every closed 1m bar by the kit, exit at the bid.
- **Take profit**: one resting limit SELL for the whole position at `entry + 2.5 * (entry - stop)`, which is 12.5% above entry. No break-even or partial.
- **Sizing**: kit sizing, 1.5% of equity lost at the stop (about 26% of equity per position, under the 50% cap).
- No time stop. Anything open at the end of the window is sold at the bid by the arena.

| Parameter | Value | Why |
|---|---|---|
| STOP | 5% | Wider than short-term noise. 4.5%, 5% and 5.5% all gave a positive 0:80 (+4.4, +7.9, +3.9 at TP 2.5R and 1% risk). 4% was negative (-6.2 at TP 2R) and 3% was negative |
| MULT | 2.5 | 2 and 3 were both positive on 0:80, 1.5 was flat (-0.2) |
| RISK | 1.5% | Scales return and drawdown. 1% gave 10.4% / DD 6.8%, 1.5% gave 15.5% / DD 10.1% on full train |
| EXPIRE | 60 | A stale resting order fills late into a falling price. 30, 60 and 90 on 0:80 gave +4.3, +8.6, +5.3 |

## Variants tried

About 30 in total.
- About 20 arena runs on 0:80: stop 3% to 6%, TP multiple 1.5 to 3, risk 1% and 1.5%, time stop 1440, 24h range-position filter, RR cap, looser detector (minStop 0.5%, minScore 3 or 5, 1m scan added), expiry 30 to 180.
- 7 arena runs on 80:120. Two were accidental early looks (the first design at STOP 4%, MULT 2: -2.7%; and an earlier run). The others were neighbour checks of the final design (stop 4.5% and 5.5%, expiry 60 and 90).
- A further ~100 offline combinations of exits and filters on a recorded setup log (`record.ts`, `sim.ts`, `exits.ts`, `rules.ts`, `wider.ts`, `feat.ts`). These were evaluated on days 0:80 only for selection.

What did not help on 0:80: a time stop, an "extended price" filter (top of the 24h range), an RR cap, a looser detector (clearly worse: -5% to -10%, the tight-structure setups are poor), a 1m scan (no extra trades), and any partial or break-even logic.

## Results (arena, `--json`)

| Span | ict-plus | incumbent |
|---|---|---|
| 0:80 (fit) | +12.89%, DD 10.05%, 24 trips, win 45.8%, PF 1.58 | -11.94%, DD 14.84%, 25 trips, win 16%, PF 0.35 |
| 80:120 (validate) | +1.26%, DD 4.77%, 7 trips, win 42.9%, PF 1.15 | -5.08%, DD 7.28%, 6 trips, win 16.7%, PF 0.26 |
| full train | +15.53%, DD 10.05%, 31 trips, win 45.2%, PF 1.48, fees 241k | -16.41%, DD 19.87%, 31 trips, win 16.1%, PF 0.33 |

Per-symbol P&L, full train (TMN): PUMP +530k (3 trips), APE +382k (7), TRX +179k (1), XRP +186k (1), ADA +162k (1), SOL +44k (2), STMN +10k (3), USOON -4k (3), BNB -80k (1), PEPE -95k (1), DOGE -165k (1), LTC -174k (2), ARB -199k (5).

## Known weaknesses

- **Very few trades**: 31 in 120 days, about 15 per 60 days. The arena asks for at least 20 round trips in the 60 test days, so this strategy (and the incumbent, also 31) may not qualify unless the test window is busier. I found no principled way to add trades: a looser detector or a 1m scan gave more trades with worse results, or none at all.
- **Out-of-sample edge is thin**. The 80:120 result is +1.26% on 7 trades: positive, but statistically indistinguishable from zero. The 0:80 result was tuned (stop, TP multiple, expiry), so about +13% there is optimistic. The honest expectation is roughly flat, better than the incumbent mostly because it pays less in costs.
- **Concentrated P&L**: PUMP and APE supply most of the profit. Without them the strategy is about flat.
- Large targets (12.5%) can sit open for days, holding a slot. Average exposure was 21%.
- The 5m detector cadence changes timing slightly versus the incumbent's every-minute detector. That is a speed trade-off, not a free improvement.

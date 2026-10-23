# Research: how the strategy was chosen

The production strategy was selected in a controlled **strategy tournament** with a held-out test window, the standard way to separate a real edge from a lucky backtest. Every number on this page can be regenerated with the commands shown.

## 1. Protocol

| Item | Value |
|---|---|
| Data | Wallex 1m candles, 2026-04-25 to 2026-10-22 (180 days), 15 liquid allowed TMN markets, about 3.9 million candles |
| Train window | First 120 days. Contestants could only see and tune on this window |
| Test window | Last 60 days, **held out**. Run once per strategy by the judge after the contestants had finished |
| Costs | Maker 0.25%, taker 0.30%, a 30 bps spread around every close (three times the production default, deliberately harsh) and 10 bps slippage on taker fills |
| Fills | An order placed on bar *i* fills from bar *i+1* at the earliest. Limit buys fill only if price trades through by one tick |
| Rules enforced by the runner | Long only, spot, LIMIT orders only, at most 2 positions, at most 50% of equity per position. Violations are rejected and counted (all strategies finished with zero) |
| Harness | `arena/run.ts`, rules in [arena/README.md](../arena/README.md) |

Four independent contestants each built one strategy family, with no access to the test window:

| Contestant | Family |
|---|---|
| `trend-breakout` | 4-day breakouts with a market-breadth gate and an ATR trailing stop |
| `rotation-momentum` | Hold the 1 or 2 strongest markets while the basket trends up |
| `mean-reversion` | Buy fast washouts and sell the rebound |
| `ict-plus` | Refinements of the original ICT model |
| `baseline-ict` | The original ICT strategy, as the incumbent |

## 2. Results

**Held-out test window (60 days, never seen during development):**

| Strategy | Return | Max drawdown | Round trips | Win rate | Profit factor | Edge over passive exposure |
|---|---|---|---|---|---|---|
| **trend-breakout (winner)** | **+25.99%** | **7.90%** | 17 | 41.2% | **4.62** | **+12.6 points** |
| ict-plus (runner-up) | +24.48% | 7.83% | 26 | 50.0% | 2.19 | +8.1 points |
| rotation-momentum | +27.47% | 12.40% | 19 | 42.1% | 2.58 | +3.6 points |
| mean-reversion | +4.76% | 14.83% | 124 | 58.1% | 1.08 | -4.1 points |
| baseline-ict | -3.18% | 10.68% | 29 | 27.6% | 0.83 | negative |

**Train window (120 days):**

| Strategy | Return | Max drawdown | Round trips | Profit factor | Edge over passive exposure |
|---|---|---|---|---|---|
| **trend-breakout** | **+20.94%** | **7.65%** | 23 | **2.93** | **+14.8 points** |
| ict-plus | +15.53% | 10.05% | 31 | 1.48 | +7.4 points |
| rotation-momentum | +21.37% | 16.71% | 39 | 1.71 | +9.8 points |
| mean-reversion | +57.23% | 10.10% | 238 | 1.64 | +52.6 points |
| baseline-ict | -16.41% | 19.87% | 31 | 0.33 | negative |

### Edge over passive exposure

Prices are quoted in toman, and the toman weakened against the dollar over both windows (USDT/TMN rose about 26% in the train window and 39% in the test window), which lifted most markets in TMN terms. A long-only strategy earns part of that rise simply by being invested. To measure skill rather than market drift, each strategy is compared with a passive holding of the same basket at the **same average exposure** (share of equity in coins, measured bar by bar):

`edge = strategy return - average exposure x basket buy-and-hold return`

The breakout strategy was invested only 16% to 21% of the time on average, yet earned **12.6 to 14.8 points more than passive holding at that exposure in both windows**. It is the only contestant with a large, stable edge in both windows, with the highest profit factor on the test window and a drawdown under 8% in both.

### Why the winner won

| Criterion | trend-breakout |
|---|---|
| Profitable in train and test | Yes, +20.9% then +26.0% |
| Edge over passive exposure in both windows | +14.8 and +12.6 points, the most stable of all |
| Drawdown | 7.7% on train (the lowest of all contestants) and 7.9% on test (within 0.1 points of the lowest) |
| Profit factor on unseen data | 4.62, the highest |
| Robustness | Every parameter neighbour tested (lookback 72-120 h, stop 3-5 ATR, volume 1.0-2.0x, gate 0.6-0.8) was profitable on train |
| Trade count | 40 trades across both windows, consistent behaviour in both |

The improved ICT model (`ict-plus`) turned the incumbent's loss into a solid profit on both windows and finished a strong second, with the most trades of the profitable contestants; its code and notes are in `arena/ict-plus/`. Mean reversion had the best training result but did not hold up on unseen data, which is exactly what the held-out protocol is designed to catch. Rotation earned a similar return to the breakout strategy but most of it came from market exposure, and its drawdown was 60% larger.

## 3. From winner to production: adding activity

The breakout strategy trades about once every three days, so the second-best idea for activity was added beside it. Pairing the winner with each runner-up in one position book, on the same harness and costs:

| Combination | Train return | Train max DD | Test return | Test max DD | Round trips (train / test) | Per 3 days | Edge over passive (train / test) |
|---|---|---|---|---|---|---|---|
| Breakout alone | +20.33% | 7.55% | +23.86% | 7.85% | 23 / 17 | about 0.7 | +14.2 / +13.1 |
| Breakout + ict-plus | +29.59% | 8.40% | +23.43% | 11.37% | 36 / 28 | about 1.1 | +21.8 / +5.5 |
| **Breakout + washout (production "combo")** | **+30.73%** | **7.60%** | **+17.52%** | **7.85%** | **184 / 84** | **about 4.4** | **+23.3 / +6.4** |

The combo multiplies trading activity by about six while staying profitable with the same low drawdown in both windows, so it is the production default (`strategy.active = "combo"`). The washout model's risk per trade (`riskMult`) was set to 1% because that was clearly better on the train window (profit factor 1.78 against 1.41 at 2%, drawdown 7.6% against 11.7%). `--strategy breakout` runs the winner alone.

## 4. Production parity

The winning research code was rebuilt as a production module (`src/strategy/breakout/`) with the risk guard, the AI supervisor, the decision log, restart persistence and tick-level stops. The production module was then run through the same tournament harness:

| Version | Window | Return | Max DD | Round trips | Win rate | Profit factor |
|---|---|---|---|---|---|---|
| Research version | train | +20.94% | 7.65% | 23 | 52.2% | 2.93 |
| Production, flat 1% risk | train | +20.65% | 7.55% | 23 | 52.2% | 2.93 |
| Production, as shipped (profit locks on) | train | +20.33% | 7.55% | 23 | 52.2% | 2.90 |
| Research version | test | +25.99% | 7.90% | 17 | 41.2% | 4.62 |
| Production, flat 1% risk | test | +25.77% | 7.85% | 17 | 41.2% | 4.63 |
| Production, as shipped (profit locks on) | test | +23.86% | 7.85% | 17 | 41.2% | 4.40 |

Same trades, same win rates, returns within a fraction of a point. The production engine is the researched strategy.

## 5. Backtests with the production CLI

`bun run backtest` (production default `combo`, default cost model with a 10 bps spread):

| Window | Command | Return | Max DD | Round trips |
|---|---|---|---|---|
| Last 60 days | `bun run backtest --from 2026-08-23T00:00:00Z --to 2026-10-22T00:00:00Z` | **+26.79%** | **7.82%** | 75 |
| Full 180 days | `bun run backtest --from 2026-04-25T00:00:00Z --to 2026-10-22T00:00:00Z` | **+41.43%** | **6.15%** | 255 |

Trade statistics for the 180-day run (from its decision log):

| Metric | Washout | Breakout | Total |
|---|---|---|---|
| Round trips | 219 | 36 | 255 (about 4.25 per 3 days) |
| Win rate | 60.3% | 50.0% | 58.8% |
| Net PnL | +469,800 TMN | +1,601,700 TMN | +2,071,500 TMN |
| Exits | 98 take-profit, 98 time stop, 23 stop | 27 trailing stop, 8 stop, 1 time stop | |
| Fees | | | 693,000 TMN on 238.6 million TMN of volume |

`--strategy breakout` alone over the same 180 days: +35.68%, max DD 7.57%, 36 round trips.

Profit locks halve the risk per trade after +15% and again after +30%, which is why the 180-day figure compounds less than train and test separately: the bot protects gains once it is ahead.

## 6. Reproduce

```bash
bun install
# the tournament (train window for anyone, test window with ARENA_FINAL=1)
bun arena/run.ts --strategy arena/strategies/production-combo.ts
ARENA_FINAL=1 bun arena/run.ts --strategy arena/strategies/production-combo.ts --window test
ARENA_FINAL=1 bun arena/run.ts --strategy arena/strategies/production-breakout.ts --window test
ARENA_FINAL=1 bun arena/run.ts --strategy arena/trend-breakout/strategy.ts --window test
# production backtests
bun run backtest --from 2026-08-23T00:00:00Z --to 2026-10-22T00:00:00Z
bun run backtest --from 2026-04-25T00:00:00Z --to 2026-10-22T00:00:00Z
```

Candles are fetched from the public Wallex API on the first run and cached per day in `data/candles/`, so no API key is needed. Each contestant's notes are in `arena/<name>/NOTES.md`. The walk-forward study of the original ICT model is in [ICT_WALKFORWARD.md](ICT_WALKFORWARD.md).

# Risk management

All limits live in code. The AI cannot raise any of them. Sizing is in `src/risk/size.ts`, account limits in `src/risk/guard.ts`, scheduling in `src/daemon.ts`.

## 1. Position sizing (fixed fraction of equity at risk)

The position value `N` is chosen so that a stop-out loses `riskPct` of equity, counting the entry fee, the stop-exit fee and slippage.

```
s    = (entry - stop) / entry                         stop distance
cost = s + maker + (1 - s) * taker + slippage         loss per unit of position value at the stop
N    = equity * riskPct / cost
N    = min(N, 50% of equity)                          cap
qty  = floor(N / entry) to the market step size
```

Defaults: `riskPct` 1%, maker 0.25%, taker 0.3%, slippage 0.1%, cap 50%. Equity is read from the account (TMN plus holdings valued at the bid) just before each decision, so size shrinks after losses and grows after wins.

Worked table, equity 5,000,000 TMN:

| Stop distance | Position value | % of equity | Loss at stop | Cap binds |
|---|---|---|---|---|
| 1.00% | 2,500,000 | 50.0% | 41,175 (0.82%) | yes |
| 1.35% | 2,500,000 | 50.0% | 49,899 (1.00%) | boundary, about 1.354% |
| 1.50% | 2,330,459 | 46.6% | 50,000 (1.00%) | no |
| 2.00% | 1,891,074 | 37.8% | 50,000 (1.00%) | no |
| 2.50% | 1,591,090 | 31.8% | 50,000 (1.00%) | no |

The detector only emits stops between 1.0% and 2.5%. A wider stop means a smaller position, so the loss stays at 1%. When the cap binds the trade is smaller, never riskier.

After a profit lock (section 2) the same formula runs with a smaller `riskPct`:

| Stop distance | Value at 0.5% risk | Value at 0.25% risk |
|---|---|---|
| 1.0% | 1,517,911 | 758,956 |
| 2.0% | 945,537 | 472,769 |
| 2.5% | 795,545 | 397,772 |

Rejections: quantity rounds down to the step size. If the value is under the market's `minNotional` or `minQty`, the trade is skipped (`sizing: ...` in `setup.rejected`). The AI may shrink a position (multiplier below 1), never enlarge it. A shrink under the minimum is also rejected.

## 2. Guard limits (`createGuard`, all overridable by env)

| Rule | Default | Env | Effect |
|---|---|---|---|
| Risk per trade | 1% | `RISK_PCT` | Base `riskPct` |
| Profit lock 1 | total PnL at least +15% | `LOCK1_PNL`, `LOCK1_RISK` | Risk drops to 0.5% |
| Profit lock 2 | total PnL at least +30% | `LOCK2_PNL`, `LOCK2_RISK` | Risk drops to 0.25% |
| Daily loss halt | equity 12% below the day's peak | `DAILY_LOSS_HALT` | No new entries until the next UTC day. The peak resets to current equity at 00:00 UTC |
| Hard drawdown kill | equity 30% below start equity | `HARD_DRAWDOWN` | No new entries for the rest of the run. Persisted in the guard state |
| Loss streak pause | 3 losing trades in a row | `LOSS_STREAK`, `LOSS_PAUSE_MIN` (30) | 30 minute pause. Any non-losing trade resets the count |
| Entry rate | 6 entries per rolling hour | `MAX_ENTRIES_PER_HOUR` | Further entries blocked until the window frees |
| Kill file | `STOP` in the repo root | none | Blocks entries while the file exists |
| Max positions | 2 (open plus pending) | code option `maxPositions` | No third entry |
| Spread | 1% | code option `maxSpreadPct` | Candidate rejected |

Total PnL is measured against the start equity of the run (the TMN balance at start in live mode, `START_TMN` otherwise). On a 5,000,000 TMN start: day halt at 12% below the day's peak (for a 5.0M peak: 4,400,000), hard kill at 3,500,000, profit locks at 5,750,000 and 6,500,000.

What a block does: it stops **new** entries and cancels pending (unfilled) entry orders. Open positions keep being managed (TPs, stop, time stop). `blockReason` is shown in every `daemon.heartbeat`.

The `STOP` file is checked only by the `live` daemon. `backtest`, `shadow` and `dry` build their guard without it.

Honest note: with 1% risk and a 3-loss pause, a 12% day halt needs a long series of losses, so the pause and the 1% sizing do most of the work. The halts are the backstop.

## 3. Stops and exits

Every position has a stop from the moment it is entered (stop price in the order metadata and in `entry.placed`). The stop is never widened. After TP1 it moves up to `entry * 1.006`. It is watched by the daemon every 5 s and on every closed 1m bar, and executed as a marketable limit sell. A time stop closes a position that is still below entry 240 minutes after the fill. See STRATEGY.md section 7.

Because the stop is not an exchange order, a dead process means an unprotected position. The daemon raises `daemon.degraded` and a console alarm when the API fails for 5 minutes with positions open.

## 4. End of run

| Time | What happens |
|---|---|
| `RUN_END` minus 45 min (`ENTRY_CUTOFF_MIN`) | Entries disabled, pending entries cancelled |
| `RUN_END` minus 15 min (`FLATTEN_MIN`) | Strategy stops managing. Pullout runs and repeats every 60 s until nothing sellable is left |
| `RUN_END` | Daemon exits. Exit code 1 and a console warning if still holding something |

`RUN_END` defaults to now plus 24 h when unset (a warning is logged). The challenge requires profit to be realised in TMN, so the plan is to be flat in TMN before the official end. Set `RUN_END` earlier than the official end by at least the flatten window plus a margin.

## 5. Pullout (`src/pullout.ts`, `bun run pullout --yes`)

1. Cancel **every** open order on the account (TPs and entries included).
2. For each holding, pick the `<ASSET>TMN` market, else `<ASSET>USDT`. No market means it is listed as unroutable.
3. Sell with a marketable **limit** order at `bid * (1 - slip)` (limit orders work where market orders are disabled). Slip steps: 0.2%, 0.4%, 0.8%, 1.5%, 3%, 5%, 8%, 12%, one step per round.
4. Wait 2.5 s, cancel its own unfilled sell orders, re-plan, repeat (at most 8 rounds). USDT is sold last, via `USDTTMN`.
5. Holdings below `minQty` or `minNotional` are reported as dust and cannot be sold.

Without `--yes` the command prints the plan and sends nothing. With `--yes` it exits with code 1 if something sellable remains: run it again.

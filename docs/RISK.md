# Risk and capital management

Risk is controlled in code at four independent levels: every trade, the whole account, every order, and the operator. None of them can be overridden by the AI.

## 1. Per trade: size from the stop

Every trade has a stop from the moment it is entered, and the position size is calculated from that stop so a stop-out costs a fixed share of the account, fees and slippage included.

```
riskBudget   = equity x riskPct                      (1% by default)
lossPerUnit  = (entry - stop) + entry x taker fee + stop x taker fee + entry x slippage
quantity     = min( riskBudget / lossPerUnit , 50% of equity / entry price , free TMN / entry price )
```

| Rule | Value | Effect |
|---|---|---|
| Risk per trade | 1% of equity at the stop | A losing trade costs about 50,000 TMN on a 5,000,000 account |
| Position cap | 50% of equity per position | **The bot never enters with all its money** |
| Open positions | At most 2 (pending entries count) | At most two independent risks at once |
| Initial stop | Breakout: 4 ATR below the signal close (typically 3% to 6%). Washout: 6% below the signal close | Gives the trade room, defines the size |
| Trailing stop | Breakout: 8 ATR below the highest price since entry, only moves up | Locks in profit as the trade runs |
| Take-profit | Washout: resting limit sell 4% above | Banks the rebound at the maker fee |
| Time stop | Breakout 336 hours, washout 8 hours | No position is held indefinitely |
| AI | Can only shrink or veto | Size can only go down after the rules |

Worked example (equity 5,000,000 TMN, entry 41,260, stop 39,550): the loss per unit is 1,994 TMN, so the bot buys 25.07 units worth 1,034,000 TMN (21% of equity). If the stop is hit the account loses about 50,000 TMN, 1.0%.

## 2. Account level: the risk guard

`src/risk/guard.ts` tracks equity on every cycle and blocks new entries when a limit is reached. Open positions keep their stops.

| Rule | Default | Setting | Effect |
|---|---|---|---|
| Profit lock 1 | Total PnL at least +15% | `risk.lockTiers[0]` | Risk per trade drops to 0.5% |
| Profit lock 2 | Total PnL at least +30% | `risk.lockTiers[1]` | Risk per trade drops to 0.25% |
| Daily loss halt | Equity 12% below the day's peak | `risk.dayLossHalt` | No new entries until the next UTC day |
| Hard drawdown halt | Equity 30% below the start | `risk.hardDrawdown` | No new entries for the rest of the run, persisted across restarts |
| Kill switch | `STOP` file exists | `risk.killFile` | No new entries until the file is removed |
| Market gate (strategy) | Fewer than 70% of markets in an uptrend | `strategy.breakout.breadthMin` | No new breakout entries |
| Crash filter (strategy) | More than half the markets fell over 2% in the last hour | `strategy.washout.crashBreadthMax` | No new washout entries |

On a 5,000,000 TMN start: day halt 12% below the day's peak, hard halt at 3,500,000, profit locks at 5,750,000 and 6,500,000.

In the 180-day backtest the largest peak-to-trough drop of the account was 6.15%, and 7.85% on the unseen test window of the strategy tournament: well inside every limit.

## 3. Every order: independent checks

Before any order reaches Wallex:

1. **Allowed markets only.** Buys on markets in `config/blocked-markets.txt` are refused. Holdings are only ever sold through TMN markets.
2. **Exchange rules.** Quantity rounded down to the step, price to the tick, minimum quantity and value enforced.
3. **Order sanity check** (live adapter, independent of the strategy): a buy worth more than `risk.maxOrderTmn` (3,000,000 TMN), priced more than 3% above the live ask, or below half the bid is refused and logged as `exchange.order_refused`. Sells are never blocked, so a position can always be closed.
4. **Free balance.** The strategy never sizes beyond the free TMN balance.

## 4. Stops and exits

The stop is enforced by the bot rather than as a resting exchange order, so the bot can apply the trailing logic and sell with the right price on every market:

- every closed 1-minute bar: if the low touched the stop, sell;
- every 5 seconds in live and shadow modes: if the live bid touched the stop, sell immediately;
- the exit is a marketable limit sell at the bid, lowered by 0.5% per retry up to 12% until it fills;
- the trailing stop is recomputed every minute and logged (`stop.trail`) each time it rises.

The daemon alarms (`daemon.degraded`) if the exchange is unreachable for 5 minutes while positions are open, and the Grafana rule "bot down" fires within two minutes if the process stops.

## 5. End of the run and pullout

| Time | What happens |
|---|---|
| `RUN_END` minus 45 min (`ENTRY_CUTOFF_MIN`) | New entries stop; open positions keep their stops and trailing stops |
| `RUN_END` | Pending buys are cancelled and the daemon exits with a summary |
| Operator | `bun run pullout --yes` converts every holding to TMN, so the result is realised in TMN as the challenge requires |

Pullout (`src/pullout.ts`): cancels every open order, then sells each holding through its TMN market with a marketable limit at `bid x (1 - slip)`, with slip stepping 0.2%, 0.4%, 0.8%, 1.5%, 3%, 5%, 8%, 12% until filled. A failed cancel is logged and skipped. Without `--yes` it only prints the plan. It was verified on the live account: it sold the test holding on its first step.

## 6. Why the losses stay small

- Each trade risks 1%, and the guard halves that after the account is up 15%.
- The market gate blocks breakouts when most coins are not trending up, which is when breakout strategies lose, and the crash filter blocks washout buys during a market-wide fall.
- Breakout winners run with a wide trailing stop while losers are cut at the initial stop: in the 180-day backtest of the breakout model alone the average winner was 3.5 times the average loser.
- Washout trades are short: a 4% take-profit, a 6% stop and an 8-hour time stop.
- Two positions at most, never more than half the account in one.

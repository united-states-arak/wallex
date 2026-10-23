# Wallex integration

The trading engine talks to Wallex through the official REST API (`src/wallex/rest.ts`). The Wallex MCP server is configured for the AI development agent (`opencode.json`). Every endpoint below was exercised against the live challenge account with real orders before the run.

## Endpoints used

| Purpose | Endpoint | Used by |
|---|---|---|
| Market list, tick and step precision, minimums | `GET /v1/markets` | Startup, order validation, universe selection |
| Best bid and ask | `GET /v1/depth?symbol=` | Equity, stop checks every 5 s, order sanity check |
| 1-minute candles | `GET /v1/udf/history?symbol=&resolution=1&from=&to=` | Strategy data (one UTC day per request, cached per day) |
| Balances | `GET /v1/account/balances` | Equity, fills, sizing |
| Open orders | `GET /v1/account/openOrders?symbol=&per_page=100` | Entry and exit tracking |
| Place order | `POST /v1/account/orders` | Entries, exits, pullout |
| Cancel order | `DELETE /v1/account/orders` with `{ clientOrderId }` | Expiring entries, pullout |
| One order with fills and fee | `GET /v1/account/orders/{client_id}` | Fill audit |

Authentication is the `x-api-key` header on the account endpoints only. Public data needs no key, which is why backtests and the dashboard run without one.

## Verified response shapes

| Endpoint | Shape (values omitted) | Handling |
|---|---|---|
| Markets | `result.symbols{SYM: {symbol, baseAsset, quoteAsset, stepSize, tickSize, minQty, minNotional, isMarketTypeEnable, stats{...}}}`. `stepSize` and `tickSize` are decimal counts | Parsed into `MarketMeta`. TMN markets report `minNotional` in rial (50000); the exchange enforces 5,000 toman, so the client stores it in toman |
| Depth | `result{ask:[{price, quantity, sum}], bid:[...]}` | Best bid = max bid price, best ask = min ask price |
| Balances | `result.balances{ASSET: {asset, value, locked, ...}}`, where `value` is the total including `locked` | `free = value - locked` |
| Open orders | `result.orders[{symbol, side, clientOrderId, price, origQty, executedQty, status, ...}]` | Client id, symbol, side, price and quantity mapped exactly |
| Place | HTTP 201, the order object with `status`, `executedQty`, `executedSum`, `fills[]`, `fee`. A marketable order returns already `FILLED` | Status, filled quantity and average price (`executedSum / executedQty`) are read from the reply |
| Cancel | The order object with `status: "CANCELED"` | Unknown ids return 404, which the pullout logs and skips |

Fees: the taker rate is 0.30%. On a buy the fee is charged in the purchased coin, on a sell in TMN. The strategy always reads the actual coin balance after a fill, so this is handled exactly.

## Live verification

Before the run, the full order lifecycle was exercised on the challenge account through the production adapter (`LiveExchange`) and the pullout:

| Step | Result |
|---|---|
| Passive limit buy below the market | Appeared in open orders with the right client id, side, price and quantity; cancelled by client id |
| Marketable limit buy | Filled at once; coin balance and fee confirmed |
| Resting take-profit sell | Listed as open, coin shown as locked; cancelled |
| Marketable limit sell (stop exit path) | Filled at once; back to TMN |
| Second market (SOLTMN) buy and sell | Filled both ways |
| `bun run pullout --yes` | Sold the holding on its first price step; account flat |
| Challenge capital | The orders spend the 5,000,000 TMN hackathon credit on the account's trading sub-account |

Measured latency from the bot to Wallex:

| Call | Median | Worst |
|---|---|---|
| Place order | 136 ms | 325 ms |
| Cancel order | 60 ms | 78 ms |
| Balances | 89 ms | 672 ms |
| Open orders | 55 ms | 192 ms |
| Depth | 60 ms | 137 ms |

Rate limits observed: 600 requests per window on balances and 900 on order endpoints. The bot's steady-state load is one candle request per market every 20 s and one depth request per market every 5 s, far below the limits.

## Order rules applied before every request

1. The market must be known to the exchange, and buys are refused on markets listed in `config/blocked-markets.txt`. Every traded market is a TMN pair.
2. Quantity is rounded down to the market's step, price to its tick.
3. Quantity and value must meet the market's minimums.
4. Market-type orders are not used; every order is a LIMIT order (marketable when it must fill now).
5. Live buys pass the independent sanity check (maximum value and distance from the live price). See [SECURITY.md](SECURITY.md).
6. Client ids are unique, deterministic and match `^[A-Za-z0-9_-]{1,64}$`: `bo_<market>_<bar time>` for breakout entries, `wa_<market>_<bar time>` for washout entries, with `_tp` for the take-profit and `_x<n>` for exit attempts.

## MCP

`opencode.json` registers the Wallex MCP server (`https://api.wallex.ir/mcp`) for the AI development agent, with the key taken from `WALLEX_API_KEY`. It gives the agent tools for markets, depth, balances, orders, margin and the credit (prop) sub-account, which makes the account and the API explorable in plain language while building and operating the bot. The trading loop itself uses the REST API directly, because the order path must be fast, deterministic and testable.

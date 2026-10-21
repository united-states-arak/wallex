# ICT Strategy Specification for an AI Trading Agent

**Target venue:** Wallex (crypto exchange)
**Document scope:** Phase 1 — the strategy itself, defined precisely enough to be coded later. Phase 2 (implementation: data feeds, order execution, backtesting harness) comes after this document is reviewed and approved.
**Audience:** An AI agent (and the humans supervising it).

---

## 0. Read This First

### 0.1 What this document is
ICT ("Inner Circle Trader", created by Michael J. Huddleston) is a **discretionary** trading methodology taught mostly through long YouTube videos. It was never published as a formal, unambiguous rulebook. Terms like "displacement", "order block" and "market structure shift" are defined slightly differently by different students.

This document is therefore an **algorithmic interpretation** of ICT concepts. Where ICT leaves room for judgement, this document picks one explicit, testable rule and marks it as a **[PARAM]** (a tunable parameter). Nothing here is claimed to be "exactly what ICT says".

### 0.2 Hard rules for the agent
1. **No evidence of profitability is assumed.** This strategy must be backtested and paper-traded before any real capital is used. Never skip this.
2. **Only act on closed candles.** Never use the currently forming candle to confirm a swing, a gap, a sweep or a structure shift. (Repainting = invalid backtests = fake results.)
3. **No lookahead.** A swing point is only "known" after enough candles have closed to confirm it.
4. **No trade is a valid outcome.** Most of the time the correct action is to do nothing.
5. **Risk limits override everything.** If any risk rule in Section 11 is violated, the trade is rejected regardless of how good the setup looks.
6. **Every decision must be explainable.** For each trade (or rejected setup) the agent writes a structured log (Section 13).
7. **When uncertain, stand aside.** Ambiguous structure = no trade.

### 0.3 Important venue assumption to verify
ICT is symmetrical (long and short setups). **If Wallex is used as spot only, the agent can only take LONG trades** (buy, then sell). In that case all bearish setups are used **only as context/exit signals**, never as entries. Confirm Wallex's available products (spot only vs. margin/futures) before Phase 2. This spec is written for both cases; see the `ALLOW_SHORTS` parameter.

---

## 1. Core Philosophy (what the strategy believes)

ICT's central claim: price is not random; it moves from one pool of liquidity to another, engineered by large participants ("smart money", "institutional order flow").

The simplified logic chain:

1. **Liquidity exists in predictable places.** Stop-losses and pending orders cluster above obvious highs (buy-side liquidity) and below obvious lows (sell-side liquidity).
2. **Large players need that liquidity** to fill big orders, so price often **raids** those levels first.
3. **After a raid, price reverses** with energetic movement (**displacement**) that breaks market structure and leaves **imbalances** (Fair Value Gaps).
4. **Price tends to return** to those imbalances / order blocks (retracement) before continuing.
5. **Premium vs. discount:** buy cheap (discount of the range), sell expensive (premium).
6. **Time matters.** The highest-probability moves happen in specific time windows (**Killzones**).
7. **Higher timeframe sets the direction** (bias); lower timeframes give the entry.

The agent's job: (a) decide bias, (b) wait for liquidity to be taken in the right place and time, (c) wait for confirmation (MSS + displacement), (d) enter on a retracement into an imbalance/block, (e) target the next liquidity pool, (f) protect capital.

---

## 2. Glossary and Precise Definitions

All definitions below assume **closed candles** with fields: `open, high, low, close, volume, time`.

### 2.1 Swing points (fractals)
A **short-term swing high (STH)** is a candle whose high is higher than the highs of the `N` candles before and after it. `N = 1` is the classic ICT 3-candle swing.
- **STH:** `high[i] > high[i-1]` and `high[i] > high[i+1]`
- **STL:** `low[i] < low[i-1]` and `low[i] < low[i+1]`
- Confirmation lag: the swing is only known after candle `i+1` closes.
- **[PARAM]** `SWING_N = 1` (default). Try 2 on noisy lower timeframes.

Hierarchy (ICT's market-structure ladder):
- **Intermediate-term high (ITH):** an STH with a lower STH on both sides.
- **Intermediate-term low (ITL):** an STL with a higher STL on both sides.
- **Long-term high (LTH):** an ITH with a lower ITH on both sides.
- **Long-term low (LTL):** an ITL with a higher ITL on both sides.

The agent uses the ladder to know which swings matter: **LTH/LTL and ITH/ITL are major liquidity and major structure; STH/STL are minor.**

### 2.2 Liquidity
- **Buy-side liquidity (BSL):** resting buy stops above highs (shorts' stop-losses, breakout buyers).
- **Sell-side liquidity (SSL):** resting sell stops below lows (longs' stop-losses, breakdown sellers).

Liquidity pool sources (ranked by importance):
1. Previous Week High/Low (PWH/PWL)
2. Previous Day High/Low (PDH/PDL)
3. Equal Highs / Equal Lows (EQH/EQL): two or more swing points within a tolerance **[PARAM]** `EQ_TOLERANCE = 0.1%` of price (or `0.15 × ATR(14)` on that timeframe)
4. Session highs/lows (Asian range high/low, London high/low)
5. Old swing highs/lows on the entry timeframe (ITH/ITL, STH/STL)
6. Trendline liquidity (optional, discretionary; **not** used in v1)

### 2.3 Liquidity sweep (raid / stop run)
Price trades **beyond** a liquidity level, then reverses back.
- **Sweep (wick type):** a candle's high exceeds the level (BSL) but the candle **closes back below** the level. Mirror for SSL.
- **Run (acceptance type):** price closes beyond the level and holds → this is a *breakout / continuation*, **not** a sweep reversal. The agent treats it differently (Section 7.6).
- A sweep must be larger than noise: **[PARAM]** `MIN_SWEEP_DEPTH = 0.02%` of price (avoid counting 1-tick pokes).

### 2.4 Displacement
Strong, energetic, one-directional price movement that shows institutional intent. Algorithmic definition (all required):
- A run of 1–3 consecutive candles in the same direction, **and**
- Total body size ≥ `DISPLACEMENT_ATR_MULT × ATR(14)` **[PARAM]** `DISPLACEMENT_ATR_MULT = 1.5`, **and**
- Candle bodies are large relative to wicks (body ≥ 60% of range) **[PARAM]**, **and**
- It leaves at least one Fair Value Gap (Section 2.5).

No displacement → no valid MSS (Section 2.7).

### 2.5 Fair Value Gap (FVG) — the core imbalance
A 3-candle pattern where the wicks of candle 1 and candle 3 do not overlap.

- **Bullish FVG:** `low[c3] > high[c1]` → gap zone = `[high[c1], low[c3]]`
- **Bearish FVG:** `high[c3] < low[c1]` → gap zone = `[high[c3], low[c1]]`
- **Consequent Encroachment (CE):** the midpoint (50%) of the gap. Important entry/invalidation reference.
- **Minimum size:** **[PARAM]** `MIN_FVG_SIZE = 0.15 × ATR(14)` (ignore tiny gaps).
- **Status lifecycle:** `fresh` → `touched` (price entered the gap) → `mitigated` (price traded through CE or fully filled) → `inverted` (see below) or `invalid`.
- **Inversion FVG (IFVG):** a bullish FVG that price closes decisively *below* becomes bearish resistance (and vice versa). Used in v2, optional.

### 2.6 Order Block (OB)
- **Bullish OB:** the **last down-close candle** before a displacement move up that breaks structure. Zone: by default the candle's **body** (`open` to `close`); optional full range. **[PARAM]** `OB_USE_BODY = true`.
- **Bearish OB:** the **last up-close candle** before a displacement move down that breaks structure.
- **Mean threshold (50% of OB):** commonly used as a line price should hold.
- A valid OB must be associated with a **displacement + MSS** (not just any last-opposite candle).
- **Mitigated** once price returns into it and trades through the mean threshold; a closed-through OB is invalid (and may become a Breaker).

### 2.7 Market Structure Shift (MSS) vs. Break of Structure (BOS)
- **BOS (continuation):** in an uptrend, price **closes** above the previous swing high (STH/ITH) in the direction of the trend. Confirms trend continuation.
- **MSS (reversal signal):** after a **liquidity sweep**, price moves with **displacement** and **closes beyond** the most recent **opposing short-term swing** (e.g., after sweeping SSL, price closes above the last STH formed on the way down).
  - Close must be beyond the level, not just a wick **[PARAM]** `MSS_REQUIRES_CLOSE = true`.
  - Must be accompanied by displacement (Section 2.4).
- ICT emphasises MSS (sweep + displacement) over a plain "CHoCH". The agent only trades reversals that have a sweep **and** an MSS.

### 2.8 Premium / Discount and Equilibrium
Define the current **dealing range**: the range between the most relevant swing high and swing low on the chosen timeframe (for entries: the range that contains the displacement leg).
- **Equilibrium (EQ):** 50% of the range.
- **Discount:** below 50% (buy zone). **Premium:** above 50% (sell zone).
- **Rule:** longs only from discount; shorts only from premium (Section 6).

### 2.9 Optimal Trade Entry (OTE)
After a displacement leg, the retracement zone between **62% and 79%** of the leg (sweet spot **70.5%**).
- Measured on the displacement leg: from the swing that was **swept** (leg start) to the extreme of the displacement (leg end).
- **[PARAM]** `OTE_LOW = 0.62`, `OTE_MID = 0.705`, `OTE_HIGH = 0.79`.
- Best entries are where OTE **overlaps** an FVG / OB / Breaker (confluence).

### 2.10 Breaker Block
An order block that **failed**: price swept liquidity, shifted structure, and traded through the original OB, flipping its role.
- **Bullish breaker:** a former bearish OB (the up-close candle(s) before a down-leg) that price later breaks **above** after a reversal; it then acts as support.
- **Bearish breaker:** mirror image.
- Breakers form naturally in the "sweep → MSS" sequence, so the agent can use them as entry zones.

### 2.11 Mitigation Block (secondary, optional)
Similar to a breaker, but forms **without** the preceding liquidity sweep of a fresh extreme (lower-high / higher-low failure). Lower priority; **not used in v1**.

### 2.12 Unicorn Model zone
The **overlap of a Breaker Block and an FVG** (the FVG should sit next to/within the breaker). Treated as a high-quality entry zone (Section 7.3).

### 2.13 Other terms
- **PD Array (Premium/Discount Array):** a ranked set of "reference zones" (FVG, OB, Breaker, old highs/lows, equilibrium) price reacts to. In discount: buy at bullish arrays; in premium: sell at bearish arrays.
- **Draw on liquidity (DOL):** the liquidity pool price is most likely heading to next; it is the **target** and the foundation of bias.
- **Judas Swing:** an early false move (usually near the session open) that raids one side before the real move goes the other way.
- **Power of 3 (PO3 / AMD):** Accumulation → Manipulation → Distribution within a candle/session/day.
- **Opening prices (reference levels):** Daily open (00:00 New York), midnight open, 08:30 NY open (US data time), weekly open. Used to judge whether price is in premium/discount *relative to the day's open*.

---

## 3. Timeframe Hierarchy

| Role | Timeframes | Purpose |
|---|---|---|
| **Bias / HTF context** | Weekly, Daily, 4H | Direction, draw on liquidity, key PD arrays |
| **Setup / structure** | 1H, 15m | Identify sweeps, MSS, dealing range |
| **Entry / execution** | 5m, 1m (3m optional) | Precise entry into FVG/OB/Breaker |

Rule of thumb: **bias from Daily/4H, setup from 1H/15m, entry from 5m/1m.** Never take an entry that opposes the HTF bias in v1.

---

## 4. Time Framework (Killzones)

All times are in **America/New_York** timezone (handle DST automatically via the timezone database; never hardcode UTC offsets). The agent must convert to UTC internally.

| Window | NY time | Role |
|---|---|---|
| **Asian range** | 20:00 – 00:00 | Builds a range = liquidity for London/NY to raid |
| **London Killzone** | 02:00 – 05:00 | Often sets the high/low of the day (manipulation) |
| **New York AM Killzone** | 07:00 – 10:00 | Highest-probability window for the main move |
| **NY Lunch** | 12:00 – 13:00 | Low-quality, avoid |
| **NY PM Killzone** | 13:30 – 16:00 | Secondary window, afternoon continuation/reversal |
| **Silver Bullet windows** | 03:00–04:00, 10:00–11:00, 14:00–15:00 | One-hour precision windows (Section 7.2) |

**Crypto adaptation:** Crypto trades 24/7 with no official session open, but global participation still follows these windows (US and London hours bring volume). v1 keeps the ICT windows. **[PARAM]** `USE_KILLZONES = true`. A later experiment can compare performance with and without killzones.

**Weekend rule [PARAM]:** `AVOID_WEEKENDS = true` (liquidity is thin; fake moves more common). Revisit after backtesting.

---

## 5. Daily Bias Procedure (Top-Down)

The agent computes a **bias** ∈ {`BULLISH`, `BEARISH`, `NEUTRAL`} once per day (before the London killzone, re-check before NY AM) and logs the reasoning.

### Step 1 — Identify the HTF draw on liquidity
Look at Weekly/Daily/4H and answer: **which liquidity pool is price most likely seeking next?**
- Candidates above price (BSL): PWH, PDH, EQH, old Daily highs, unfilled bearish FVG above.
- Candidates below price (SSL): PWL, PDL, EQL, old Daily lows, unfilled bullish FVG below.

### Step 2 — Read what price did to the last key level
- Daily closed **above** PDH and held → bullish continuation lean (draw: next BSL).
- Daily **swept** PDH but **closed back below** (wick + reject) → bearish lean (draw: PDL / SSL).
- Mirror for PDL.

### Step 3 — Check reaction at HTF PD arrays
- Price reacted from a **bullish HTF FVG/OB** (in discount) → bullish lean.
- Price reacted from a **bearish HTF FVG/OB** (in premium) → bearish lean.

### Step 4 — Premium/Discount of the HTF range
- Price in discount of the Daily/4H dealing range → favour longs.
- Price in premium → favour shorts.

### Step 5 — Combine (scoring)
Score each factor: `+1` bullish, `-1` bearish, `0` neutral.

| Factor | Weight |
|---|---|
| Draw on liquidity direction (Step 1) | ×2 |
| Reaction to last key level (Step 2) | ×2 |
| HTF PD array reaction (Step 3) | ×1 |
| Premium/Discount position (Step 4) | ×1 |
| 4H market structure direction (BOS/MSS state) | ×1 |

- Total ≥ **+3** → `BULLISH`
- Total ≤ **−3** → `BEARISH`
- Otherwise → `NEUTRAL` (**no trades**)

**[PARAM]** `BIAS_THRESHOLD = 3`.

### Step 6 — Intraday confirmation using the Daily Open (Power of 3)
- Bullish bias: the best long entries occur **below** the Daily Open (price in discount relative to the open) after a manipulation leg down (Judas swing) that sweeps SSL.
- Bearish bias: best shorts occur **above** the Daily Open after a manipulation leg up that sweeps BSL.
- If bias is bullish but price is far above the open with no sweep yet → **wait**; do not chase.

---

## 6. Universal Entry Filters (must all pass)

An entry is only valid if **every** filter below is true:

1. **Bias alignment:** trade direction == daily bias (not `NEUTRAL`).
2. **Time window:** within an allowed killzone (if `USE_KILLZONES`).
3. **Liquidity event:** a qualifying liquidity sweep occurred (Section 2.3) at a *meaningful* level (see Section 7.1 level ranking).
4. **Confirmation:** displacement + MSS in the trade direction (Sections 2.4, 2.7).
5. **Entry location:** entry zone is in **discount** for longs / **premium** for shorts of the setup's dealing range.
6. **Entry zone quality:** price is retracing into an FVG, OB, Breaker or OTE zone (Section 7), ideally with confluence of 2+.
7. **Target exists:** a clear opposing liquidity pool gives at least **minimum reward:risk** (Section 9).
8. **Risk check passes** (Section 11).
9. **No conflicting high-impact event** (macro news / exchange maintenance / extreme volatility flag) **[PARAM]** `NEWS_FILTER = true` (v1: simple volatility spike filter, see 11.4).

If a filter fails → log `REJECTED: <reason>` and wait.

---

## 7. Trade Models (Setups)

The agent implements models in this priority order. Start with **Model A** only; add others after Model A is validated.

### 7.1 Liquidity level ranking (applies to all models)
When choosing which sweep matters, prefer higher-ranked levels:

1. PWH/PWL
2. PDH/PDL
3. Equal highs/lows on 1H+ (EQH/EQL)
4. Asian range high/low
5. London session high/low (for NY setups)
6. Intermediate-term swing highs/lows on 15m–1H
7. Short-term swings (lowest priority, requires extra confluence)

### 7.2 MODEL A — "ICT 2022 Core Model" (primary)

**Story:** Bias says up → price sweeps sell-side liquidity during a killzone → displaces up with an MSS → leaves an FVG → we buy the retracement into the FVG → target buy-side liquidity.

**Long version (mirror for short):**

1. **Bias** = `BULLISH` (Section 5).
2. **Mark liquidity:** Asian low, PDL, EQL, session lows (SSL below price), and the target BSL above (PDH, EQH, Asian high, PWH).
3. **Wait for killzone** (London or NY AM; NY PM allowed as lower priority).
4. **Sweep:** price takes SSL (wick below a ranked level, closes back above it) — Section 2.3.
5. **MSS on 15m/5m:** displacement up **closes above** the last short-term swing high formed during the move down. Must leave an FVG.
6. **Define the dealing range:** the swept low (leg start) → the displacement high (leg end).
7. **Entry zone candidates (in order of preference):**
   a. Overlap of **FVG ∩ OTE (62–79%)** ← best
   b. FVG created by the displacement
   c. Bullish OB / Breaker at the base of the displacement
   d. OTE zone alone (lowest priority)
8. **Entry trigger:** limit order at the **CE (50%) of the FVG** or at the OTE mid-point (70.5%) — whichever lies inside the zone; or a **confirmation entry** on 1m: after price taps the zone, an MSS on 1m in the trade direction (more conservative, worse price). **[PARAM]** `ENTRY_MODE = "limit_at_ce"` | `"confirm_1m"`.
9. **Stop-loss:** below the **swept low** (the liquidity raid extreme), with a small buffer **[PARAM]** `SL_BUFFER = 0.05 × ATR(14)` or 0.03% of price. (Tighter alternative: below the OB/FVG origin candle low; riskier — more often stopped by noise.)
10. **Invalidation (cancel the setup before filling):** price closes below the swept low, **or** price trades through CE of the FVG without a reaction and closes below the FVG, **or** the killzone ends and price never returned to the zone **[PARAM]** `CANCEL_AT_KILLZONE_END = true`.
11. **Take profit:** see Section 9.

### 7.3 MODEL B — Unicorn Model

Same story as Model A, but the entry zone must be a **Breaker Block overlapping an FVG** formed during the sweep → MSS sequence.
- Entry at the overlap; stop beyond the breaker's far edge (or beyond the swept extreme if closer to a safe invalidation).
- Considered higher precision, but rarer. Implement after Model A.

### 7.4 MODEL C — Silver Bullet (time-boxed)

A one-hour window version; simple and rule-based, good for automation.
- Windows (NY): **03:00–04:00, 10:00–11:00, 14:00–15:00**.
- Inside the window: look for the **first valid FVG** that forms **after** a liquidity sweep/MSS and is **aligned with bias**.
- Enter on the retracement into that FVG (CE or edge).
- Stop: beyond the FVG's candle-1 extreme (or swept extreme if farther / safer).
- Target: the **nearest opposing liquidity**; require minimum RR (Section 9).
- Only **one** Silver Bullet attempt per window.
- **Crypto note:** the original is calibrated for index futures (target of ~10–15 points). In crypto, define the minimum target as a multiple of the stop distance, not a fixed point count.

### 7.5 MODEL D — Turtle Soup / Raid Reversal (counter-liquidity)

Reversal at a **swing extreme** after a clear run on an old high/low on a higher timeframe (e.g., 1H/4H), only if HTF bias agrees with the reversal direction. Requires: sweep of an old ITH/ITL or EQH/EQL → rejection candle → LTF MSS → FVG entry. This is a subset of Model A at a specific level; **not a separate implementation** until Model A works.

### 7.6 MODEL E — Continuation after BOS (secondary)

If bias is bullish and structure is already bullish (HH/HL), price breaks an old high (BOS), pulls back into a **discount FVG/OB**, and the entry follows the same location rules (Section 6). Lower reward expectation; **not in v1**.

### 7.7 What the agent must NOT trade
- Counter-bias trades.
- A sweep without a close back inside + displacement (could just be a breakout).
- Entries in the **premium** for longs / **discount** for shorts.
- Setups where the stop is wider than the maximum allowed risk distance (Section 11).
- Entries during **lunch** (12:00–13:00 NY) or inside the last 15 minutes of a killzone.
- Re-entry into a setup after a stop-out **unless** a brand-new sweep + MSS sequence forms (no revenge trades).

---

## 8. Entry Execution Details

- **Order type:** **limit orders** at the planned price (maker fees are lower than taker on most exchanges — verify Wallex fee schedule in Phase 2; fees matter a lot on small targets).
- **Price precision / tick size:** round to the exchange's tick size and min notional (Phase 2).
- **Slippage assumption for backtests:** **[PARAM]** `SLIPPAGE_BPS = 5` basis points on market orders; limit fills assumed only if price **trades through** the level by at least 1 tick (not just touches) to avoid optimistic fills.
- **Setup expiry:** a planned entry expires at the end of the killzone or after `MAX_SETUP_AGE_CANDLES` **[PARAM]** (e.g., 24 candles on the 5m chart).
- **One position at a time per symbol**; at most `MAX_CONCURRENT_POSITIONS = 2` across all symbols.

---

## 9. Exits, Targets and Trade Management

### 9.1 Targets (draw on liquidity)
- **TP1:** the nearest meaningful opposing liquidity pool ranked in Section 7.1 (e.g., Asian high, previous swing high, EQH), or `1R` minimum.
- **TP2 / runner:** the next higher-ranked pool (PDH, PWH, HTF FVG).
- Always compute **expected RR** = (target − entry) / (entry − stop). **Reject** the trade if `RR_TP1 < MIN_RR` **[PARAM]** `MIN_RR = 2.0`.

### 9.2 Management rules (defaults)
1. At **TP1**: close **50%** of the position. **[PARAM]** `TP1_PARTIAL = 0.5`.
2. After TP1: move stop to **break-even** (entry ± fees).
3. Runner: trail the stop **under the most recent 15m higher low** (long) / above the most recent 15m lower high (short), confirmed (closed) swings only.
4. **Time stop:** if the trade has not moved ≥ `+0.5R` within `TIME_STOP_CANDLES` **[PARAM]** (e.g., 36 × 5m candles) and killzone ended → close at market (the thesis relied on timing).
5. **Hard invalidation exit:** an opposing MSS with displacement on the setup timeframe **before** TP1 → exit immediately (thesis broken).
6. **End-of-day flat [PARAM]:** `FLAT_BEFORE_NY_CLOSE = false` (crypto can hold; set true for stricter day-trading mode).

### 9.3 What ICT explicitly warns about (translated to rules)
- Don't hold a trade through the opposing HTF draw on liquidity without a plan.
- Don't widen stops. A stop is only ever moved to reduce risk.
- Don't add to losers.

---

## 10. Setup Quality Scoring (A+ filter)

Each candidate trade receives a score; trade only if score ≥ threshold.

| Criterion | Points |
|---|---|
| Bias score magnitude ≥ 5 (strong) | +2 (≥ 3 → +1) |
| Sweep of PWH/PWL/PDH/PDL or EQ high/low | +2 (other ranked levels +1) |
| Inside primary killzone (London / NY AM) | +2 (NY PM +1) |
| Displacement strong (≥ 2.0 × ATR) | +1 |
| FVG ∩ OTE confluence | +2 |
| Breaker/OB overlap with FVG (Unicorn) | +1 |
| Entry in deep discount/premium (beyond 70% of range) | +1 |
| RR to TP1 ≥ 3 | +1 |
| HTF PD array supports direction | +1 |

- **[PARAM]** `MIN_SCORE = 8` (out of 13). Begin strict; relax only if backtests justify.

---

## 11. Risk Management (non-negotiable)

> ICT's own teaching stresses small, consistent risk and patience. The numbers below are conservative defaults for an automated agent, **not** ICT quotes.

### 11.1 Position sizing
`position_size = (account_equity × RISK_PER_TRADE) / (entry − stop)`
- **[PARAM]** `RISK_PER_TRADE = 0.5%` of equity (hard maximum **1%**).
- Position must respect exchange minimum order size and maximum leverage (none if spot).
- Include **fees** in the risk calculation (entry + exit fees).

### 11.2 Account-level limits
- **Max trades per day:** `MAX_TRADES_PER_DAY = 2`.
- **Max daily loss:** `MAX_DAILY_LOSS = 1.5%` → stop trading until next NY day.
- **Max weekly loss:** `MAX_WEEKLY_LOSS = 4%` → stop until next week and trigger a human review.
- **Consecutive losses:** after `3` consecutive losses → pause 24h and require human review.
- **Drawdown kill-switch:** if equity drawdown from peak ≥ `10%` → **halt completely** and notify a human.

### 11.3 Stop-loss requirement
- Every order **must** have a defined stop **before** it is placed. If the stop cannot be placed (e.g., exchange limitation on spot), the agent must implement it as a **monitored conditional exit** and treat connectivity loss as an emergency (Phase 2 design topic).
- Maximum stop distance: **[PARAM]** `MAX_STOP_PCT = 1.5%` of entry price for crypto majors (reject setups that need wider stops).

### 11.4 Volatility / news filter (v1 simple version)
- If the current 5m candle range > `4 × ATR(14)` or a 1H candle range > `3 × ATR(14)` → pause new entries for `30` minutes (abnormal event).
- Exchange maintenance or deposit/withdrawal halts on the traded pair → no trading.

### 11.5 Market / instrument selection
- Start with **one** liquid instrument (e.g., BTC/USDT, then ETH/USDT).
- Liquid pairs only: reject pairs with wide spreads. **[PARAM]** `MAX_SPREAD_BPS = 8`.
- **Quote currency consideration:** if trading TMN pairs, Toman-denominated prices are affected by the USDT/IRT rate, which can move independently and break ICT structure. Prefer **USDT pairs** for the strategy logic (Phase 2: verify liquidity and data quality on Wallex).

---

## 12. Algorithmic Reference (pseudo-code for the detectors)

> These are language-neutral sketches so Phase 2 has unambiguous targets.

```text
# Swing detection (N=1), only on closed candles
is_swing_high(i):  high[i] > max(high[i-N..i-1]) and high[i] > max(high[i+1..i+N])
is_swing_low(i):   low[i]  < min(low[i-N..i-1])  and low[i]  < min(low[i+1..i+N])
# confirmed at close of candle i+N

# Fair Value Gap at candle index i (c1=i-2, c2=i-1, c3=i)
bullish_fvg(i):  low[i] > high[i-2]   -> zone [high[i-2], low[i]], gap >= MIN_FVG_SIZE
bearish_fvg(i):  high[i] < low[i-2]   -> zone [high[i], low[i-2]], gap >= MIN_FVG_SIZE
CE = (zone_low + zone_high) / 2

# Liquidity sweep of level L (buy-side)
swept_bsl(candle, L):  candle.high > L*(1+MIN_SWEEP_DEPTH) and candle.close < L
swept_ssl(candle, L):  candle.low  < L*(1-MIN_SWEEP_DEPTH) and candle.close > L

# Displacement
displacement(candles k..k+m, direction):
    total_body = sum(body)  ; avg_range = ATR(14)
    return total_body >= DISPLACEMENT_ATR_MULT * avg_range
           and body_to_range_ratio >= 0.6
           and at_least_one_fvg_created_in_direction

# MSS (bullish) after SSL sweep at time t_sweep
last_STH = most recent confirmed short-term swing high BEFORE the displacement and AFTER the sweep's down-leg began
bullish_MSS: first candle closing > last_STH.high with displacement(direction=up)

# Order block (bullish) for displacement starting at candle k
OB = last candle with close < open at or before k   -> zone [close, open] if OB_USE_BODY else [low, high]

# Premium/Discount
EQ = (range_high + range_low) / 2
in_discount(price) = price < EQ ; in_premium(price) = price > EQ

# OTE (bullish leg from L to H)
ote_low  = H - 0.79*(H-L)
ote_mid  = H - 0.705*(H-L)
ote_high = H - 0.62*(H-L)
# entry zone = [ote_low, ote_high]
```

### 12.1 State machine for Model A (per symbol)

```text
IDLE
 └─ (bias computed ≠ NEUTRAL and inside killzone) → WATCHING_FOR_SWEEP
WATCHING_FOR_SWEEP
 └─ (qualifying sweep on ranked level, aligned with bias) → WATCHING_FOR_MSS   [store swept_level, sweep_extreme]
 └─ (killzone ended / bias flipped) → IDLE
WATCHING_FOR_MSS
 └─ (displacement + close beyond last opposing STH/STL, FVG present) → SETUP_ARMED
 └─ (price takes out sweep_extreme further / expires) → IDLE
SETUP_ARMED
 └─ (compute zone, stop, targets, RR, score; filters pass) → ORDER_PLACED
 └─ (any filter fails / invalidation) → IDLE
ORDER_PLACED
 └─ (filled) → IN_TRADE
 └─ (expired / invalidated) → IDLE
IN_TRADE
 └─ (TP1 hit) → manage (partial, BE) → trail
 └─ (SL / hard invalidation / time stop / kill-switch) → CLOSED → IDLE (cooldown)
```

---

## 13. Required Logging and Output Format

For **every** evaluated setup (taken or rejected) the agent produces a JSON record:

```json
{
  "timestamp_utc": "2026-10-21T13:35:00Z",
  "symbol": "BTCUSDT",
  "model": "A_ict_2022_core",
  "bias": {"direction": "BULLISH", "score": 5, "factors": {"draw_on_liquidity": 2, "key_level_reaction": 2, "htf_pd_array": 0, "premium_discount": 1, "structure_4h": 0}},
  "killzone": "NY_AM",
  "sweep": {"level_type": "PDL", "level": 0.0, "extreme": 0.0, "time": "..."},
  "mss": {"level": 0.0, "displacement_atr": 1.8, "time": "..."},
  "dealing_range": {"low": 0.0, "high": 0.0, "equilibrium": 0.0},
  "entry_zone": {"type": "FVG_OTE_confluence", "low": 0.0, "high": 0.0, "entry_price": 0.0},
  "stop": 0.0,
  "targets": [{"name": "TP1", "price": 0.0, "pool": "Asian_high"}, {"name": "TP2", "price": 0.0, "pool": "PDH"}],
  "rr_tp1": 2.4,
  "score": 9,
  "filters": {"bias_alignment": true, "time_window": true, "liquidity_event": true, "confirmation": true, "location": true, "target_exists": true, "risk_ok": true},
  "decision": "ARMED_AND_PLACED",
  "reject_reason": null
}
```

Also keep a **daily journal** (human readable): bias reasoning, setups seen, trades taken, outcomes, deviations from rules.

---

## 14. Validation Plan (before any real money)

1. **Unit-test detectors** (swing, FVG, sweep, displacement, MSS, OB) on hand-labelled chart examples taken from ICT's own free teaching material.
2. **Backtest** Model A on ≥ 2 years of data across multiple regimes (trend, range, crash, chop). Report: win rate, average RR, expectancy per trade (in R), max drawdown, profit factor, number of trades, performance after fees and slippage. Include **out-of-sample** testing and **walk-forward** checks. Do not tune parameters on the whole dataset.
3. **Parameter sensitivity:** results must not collapse when params change slightly (a sign of overfitting).
4. **Paper trade** (live data, simulated fills) for ≥ 4–8 weeks. Compare to the backtest.
5. **Go-live criteria** (minimum): positive expectancy after costs in backtest **and** paper trading, drawdown within limits, no rule violations in logs.
6. **Live ramp:** begin with the smallest viable size; scale only after consistent behaviour.

**Expectation setting:** many ICT-style setups fail to survive costs and honest testing. A negative or flat result is a legitimate outcome and should lead to *not trading*, not to curve-fitting parameters until it looks good.

---

## 15. Parameter Summary (all tunables in one place)

| Parameter | Default | Meaning |
|---|---|---|
| `ALLOW_SHORTS` | `false` if Wallex is spot-only | Allow short entries |
| `SWING_N` | 1 | Candles each side to confirm a swing |
| `EQ_TOLERANCE` | 0.1% (or 0.15×ATR) | Equal high/low tolerance |
| `MIN_SWEEP_DEPTH` | 0.02% | Minimum liquidity poke beyond level |
| `DISPLACEMENT_ATR_MULT` | 1.5 | Displacement strength |
| `MIN_FVG_SIZE` | 0.15×ATR(14) | Ignore tiny gaps |
| `OB_USE_BODY` | true | OB zone = body vs full range |
| `MSS_REQUIRES_CLOSE` | true | Structure shift needs close, not wick |
| `OTE_LOW/MID/HIGH` | 0.62 / 0.705 / 0.79 | OTE retracement levels |
| `USE_KILLZONES` | true | Restrict trading to windows |
| `AVOID_WEEKENDS` | true | No new entries on weekends |
| `BIAS_THRESHOLD` | 3 | Min bias score |
| `ENTRY_MODE` | `limit_at_ce` | Entry method |
| `SL_BUFFER` | 0.05×ATR(14) | Stop buffer beyond swept extreme |
| `MIN_RR` | 2.0 | Minimum reward:risk to TP1 |
| `TP1_PARTIAL` | 0.5 | Fraction closed at TP1 |
| `MIN_SCORE` | 8 / 13 | A+ setup filter |
| `RISK_PER_TRADE` | 0.5% (max 1%) | Equity risk per trade |
| `MAX_TRADES_PER_DAY` | 2 | Overtrading guard |
| `MAX_DAILY_LOSS` | 1.5% | Daily stop |
| `MAX_WEEKLY_LOSS` | 4% | Weekly stop |
| `MAX_STOP_PCT` | 1.5% | Reject setups with wider stops |
| `MAX_SPREAD_BPS` | 8 | Instrument quality filter |
| `SLIPPAGE_BPS` | 5 | Backtest realism |

---

## 16. Open Questions for Phase 2 (implementation) — do NOT start until answered

1. **Wallex capabilities:** spot only, or margin/futures? Are conditional/stop orders supported via API? Fee schedule (maker/taker)?
2. **Data source:** does Wallex provide historical OHLCV at 1m–1D with enough depth, and reliable live feeds (REST/WebSocket)? If not, use a deeper external feed (e.g., a major global exchange for the same USDT pair) for signal generation and Wallex only for execution — and measure the price discrepancy.
3. **Pair choice:** USDT pairs vs. TMN pairs; liquidity and spreads on the chosen pairs.
4. **Account constraints:** API rate limits, minimum order sizes, withdrawal/deposit risks, connectivity failure plan.
5. **Agent architecture:** deterministic rule engine (recommended for detection) with the AI agent as supervisor/explainer vs. fully LLM-driven decisions (not recommended for order generation without deterministic checks).
6. **Infrastructure:** hosting location/latency, secrets management for API keys (trade-only permission, **no withdrawal permission**), monitoring and alerting, kill-switch.
7. **Backtest engine:** custom vs. existing library; candle-replay design to guarantee no lookahead.

---

## 17. Final Reminders to the Agent

- You are a **rule executor**, not a gambler. If the checklist (Section 6) is not fully satisfied, you do nothing.
- The goal is **consistent expectancy with controlled risk**, not frequent trading.
- Never override a risk limit. Never remove a stop. Never average down.
- Log everything. Be honest in the logs about missed rules or uncertain readings.
- **This document is educational and describes a trading methodology; it is not financial advice. Trading crypto carries a high risk of loss, including total loss of capital.**
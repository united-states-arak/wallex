// Imported first by arena/run.ts so the settings layer sees these before anything reads it.
// Every strategy in the arena is judged under the same, deliberately harsher-than-default cost model:
// the default 10 bps spread flatters mid-liquidity markets such as PUMP, ADA, APE or AAVE (real spreads 0.5% to 0.8%).
process.env.STARCOACH__paper__spreadBps = process.env.ARENA_SPREAD_BPS ?? '30'
process.env.STARCOACH__paper__slippageBps = '10'
process.env.OTEL_SDK_DISABLED = 'true'

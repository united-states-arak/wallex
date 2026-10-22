# Configuration

Everything tunable lives in this folder. Formats are TOML, so every file can carry comments.

| File | Purpose |
| --- | --- |
| `default.toml` | Reference: every option with its default, unit and a one-line explanation. A test keeps it equal to `src/settings/defaults.ts`. |
| `profiles/<name>.toml` | Named presets, selected with `STARCOACH_PROFILE=<name>`. List only what differs. |
| `local.toml` | Your own overrides. Gitignored. Start from `local.example.toml`. |
| `blocked-markets.txt` | Symbols that may never be traded. |

Profiles: `balanced` (the defaults), `conservative` (0.5% risk, one position, tighter halts),
`aggressive` (net RR 1.3, minScore 3, 10 entries/hour, 15% day halt), `backtest` (no kill file, telemetry off).

## Layering (lowest to highest precedence)

1. built-in defaults (`src/settings/defaults.ts`, the single source of truth)
2. `config/default.toml`
3. `config/profiles/<name>.toml` (`STARCOACH_PROFILE`, or the `profile` argument of `loadSettings`)
4. `config/local.toml`
5. environment variables
6. explicit overrides passed in code

## Environment

- `STARCOACH__section__key=value`, double underscore between levels, names match case-insensitively:
  `STARCOACH__risk__riskPct=0.005`, `STARCOACH__detect__models='["sweep"]'`, `STARCOACH__risk__lockTiers__0__pnl=0.1`.
  Values are typed from the default: number, boolean (`true/false/1/0/yes/no`), string, array
  (JSON `[...]` or comma-separated for lists of strings/numbers; tables need JSON). An empty value is ignored.
- Legacy variables still work (`MAKER_FEE`, `RISK_PCT`, `SYMBOLS`, `AI_BASE_URL`, `RUN_END`, ...). The full
  table is `LEGACY_ALIASES` in `src/settings/aliases.ts`. `STARCOACH__...` wins over a legacy name if both are set.
- `STARCOACH_PROFILE` picks the profile, `STARCOACH_CONFIG_DIR` moves the config folder.
- Environment variables are validated by `src/env.ts` (types and formats; exit 78 with a list on a bad value). Ranges stay in `src/settings/validate.ts`. Operational variables (`STARCOACH_MODE`, `STARCOACH_CONFIRM_LIVE`, `STARCOACH_ARGS`, `HEALTH_MAX_AGE_S`, `GIT_SHA`) are env-only and not settings.

## Secrets

`WALLEX_API_KEY` and `AI_API_KEY` are read from the environment only (use `.env`). A TOML file containing a key
named `apiKey`, `api_key`, `secret`, `token` or `password` is rejected with an error. `config show` and every
printed config redact them, and the config hash excludes them.

## Validation

Unknown keys are errors with a "did you mean" hint. Ranges and cross-field rules (for example
`riskPct` in (0, 0.05], `minStopPct < maxStopPct`, `flattenMin` shorter than the run) are checked on load and
all problems are listed together with their dotted path.

## Commands

```
bun run config show              # effective config and the layer each value came from
bun run config validate          # check effective config and every profile, exit 78 on problems
bun run config diff aggressive   # what a profile changes against the defaults
bun run config hash              # sha256 of the effective config (secrets excluded)
```

## Adding an option

1. Add the field to the `Settings` interface (`src/settings/types.ts`) and its default to `src/settings/defaults.ts`.
2. Add a range check in `src/settings/validate.ts`.
3. Document it in `default.toml` with the same value, unit and one line (the sync test fails otherwise).
4. Read it with `getSettings().section.key`; keep constructor/option parameters so tests can still inject values.
5. For a legacy environment name, add a row to `src/settings/aliases.ts` and a schema entry in `src/env-schema.ts` (a test fails if one is missing).

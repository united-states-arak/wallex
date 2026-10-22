#!/bin/sh
set -eu

# Any other command (bun run pullout --yes, bun src/dashboard/server.ts, sh) runs as given.
if [ "${1:-daemon}" != "daemon" ]; then
  exec "$@"
fi

# Validates the environment (src/env.ts, exit 78 on a bad value) and every config layer, then prints the hash
# that the daemon also writes to its log, so a run can be matched to the exact settings it used.
bun src/settings/cli.ts validate || exit 78
echo "config hash: $(bun src/settings/cli.ts hash)"

MODE="${STARCOACH_MODE:-paper}"
case "$MODE" in
  live) FLAG="" ;;
  paper) FLAG="--paper" ;;
  dry) FLAG="--dry" ;;
  *) echo "STARCOACH_MODE must be live, paper or dry (got: $MODE)" >&2; exit 78 ;;
esac

if [ "$MODE" = "live" ]; then
  if [ -z "${WALLEX_API_KEY:-}" ]; then
    echo "STARCOACH_MODE=live needs WALLEX_API_KEY" >&2
    exit 64
  fi
  if [ "${STARCOACH_CONFIRM_LIVE:-}" != "yes" ]; then
    echo "STARCOACH_MODE=live places real orders. Set STARCOACH_CONFIRM_LIVE=yes to confirm." >&2
    exit 64
  fi
fi

echo "starting daemon: mode=$MODE profile=${STARCOACH_PROFILE:-default} sha=${GIT_SHA:-dev}"
# STARCOACH_ARGS is split on spaces on purpose (for example: --run-end 2026-10-25T12:00:00Z --symbols auto).
# shellcheck disable=SC2086
exec bun src/cli.ts live $FLAG ${STARCOACH_ARGS:-}

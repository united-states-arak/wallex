#!/bin/zsh
# usage: [ENV=..] run.sh span   -> one-line summary
cd "$(dirname "$0")/../.."
bun arena/run.ts --strategy arena/rotation-momentum/strategy.ts ${1:+--span} ${1:+$1} --json | bun -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(["ret",o.returnPct,"dd",o.maxDrawdownPct,"trips",o.roundTrips,"win",o.winRatePct,"avg",o.avgTripPct,"pf",o.profitFactor,"sh",o.sharpeDaily,"viol",JSON.stringify(o.ruleViolations),"s",o.seconds].join(" "))'

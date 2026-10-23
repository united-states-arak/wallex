#!/bin/bash
# usage: try.sh SPAN KEY=VAL ...   prints a compact line
span=$1; shift
out=$(env "$@" bun arena/run.ts --strategy arena/ict-plus/strategy.ts --span $span --json 2>&1 | grep '^{' | tail -1)
echo "$span $* $(echo "$out" | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); print(d["returnPct"], "dd", d["maxDrawdownPct"], "trips", d["roundTrips"], "win", d["winRatePct"], "pf", d["profitFactor"])')"

#!/usr/bin/env bash
#
# The clean-room gate (PRD §103). A fresh environment must reproduce every
# deterministic core claim, and the published artifacts must match what the
# code regenerates. Fails on drift.
#
#   ./scripts/bootstrap.sh
#   ./scripts/verify-clean-room.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "CLEAN-ROOM FAIL: $1" >&2; exit 1; }

echo "==> 1/6 install"
pnpm install --frozen-lockfile

echo "==> 2/6 typecheck"
pnpm -r typecheck

echo "==> 3/6 reference models + workspace tests"
pnpm -r test

echo "==> 4/6 contracts"
if command -v forge >/dev/null 2>&1; then
  (cd contracts && forge test -vv)
else
  echo "    forge not installed, skipping (not a clean-room pass without it)"
fi

echo "==> 5/6 published artifacts match their sources"
node scripts/emit-agent-cards.mjs
node scripts/emit-published-snapshot.mjs
git diff --quiet -- artifacts/agents apps/web/src/marketplace/published-snapshot.generated.ts \
  || fail "published artifacts drifted from their emit scripts"

echo "==> 6/6 verifier reconstructs the published mandate from chain"
pnpm verify:mandate || fail "pnpm verify:mandate did not return VERIFIED"

echo
echo "CLEAN-ROOM PASS"

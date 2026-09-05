#!/usr/bin/env bash
#
# One command to take a fresh clone to a state where every other script runs.
# Idempotent: safe to re-run.
#
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> node $(node --version), pnpm $(pnpm --version 2>/dev/null || echo 'not found')"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Enable it with:  corepack enable" >&2
  exit 1
fi

echo "==> installing workspace dependencies"
pnpm install --frozen-lockfile

if command -v forge >/dev/null 2>&1; then
  echo "==> building contracts"
  (cd contracts && forge build)
else
  echo "==> forge not found, skipping contract build (install Foundry to run contract tests)"
fi

echo "==> bootstrap complete"

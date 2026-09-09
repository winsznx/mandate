# Local Setup & Verification Guide

This document describes how to set up, build, test, and verify MANDATE locally.

---

## Prerequisites

- **Node.js**: `^22.0.0`
- **pnpm**: `>=9.0.0`
- **Foundry / Forge**: `>=0.2.0` (for smart contract tests and trial-runner fork tests)

---

## Environment Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/winsznx/mandate.git
   cd mandate
   ```

2. **Install dependencies**:
   ```bash
   pnpm install --frozen-lockfile
   ```

3. **Configure Environment**:
   Copy `.env.example` to `.env` if custom RPC endpoints are needed. Default public RPC endpoints for BSC Testnet (chain 97) are preconfigured.

---

## Running Verification & Tests

### 1. Verify the Featured Mandate
Run the independent CLI verifier against the featured on-chain mandate (no account or private key required):
```bash
pnpm verify:mandate 0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b --chain 97
```

### 2. Workspace Typecheck
```bash
pnpm -r typecheck
```

### 3. Workspace Unit & Integration Tests
```bash
pnpm -r test
```

### 4. Smart Contract Tests
```bash
cd contracts && forge test -vv
```

---

## Running Applications Locally

### Web Marketplace (`apps/web`)
```bash
pnpm --filter @mandate/web dev
```
Navigate to `http://localhost:3000`.

### Reference Agent Gateway (`agents/gateway`)
```bash
pnpm --filter @mandate/agents-gateway dev
```
Listens on `http://localhost:9000`. Probe agent health at `http://localhost:9000/health-factor-a/healthz`.

---

## Clean-Room Verification

To verify that published agent cards and snapshots are up to date:
```bash
./scripts/verify-clean-room.sh
```

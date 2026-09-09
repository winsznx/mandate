# MANDATE Architecture

MANDATE is a marketplace and verification infrastructure for AI financial agents on BNB Smart Chain. It enforces **Trial-Bound Authority**, guaranteeing on-chain that an agent cannot execute actions beyond what it proved in a trial.

$$\text{GrantedEnforceableAuthority} \subseteq \text{TestedEnforceableAuthority}$$

---

## High-Level System Overview

```
                        ┌────────────────────────┐
                        │    User / Marketplace   │
                        └───────────┬────────────┘
                                    │
                               1. Browse & Select Agent
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        Services & Trial Engine                         │
│                                                                        │
│   ┌───────────────────┐    2. Fork Trial    ┌──────────────────────┐   │
│   │   Reference Model ├────────────────────►│    Trial Runner      │   │
│   └───────────────────┘                     └──────────┬───────────┘   │
│                                                        │               │
│                                         3. Publish     ▼               │
│                                             ┌──────────────────────┐   │
│                                             │ MandateReceiptReg.   │   │
│                                             └──────────┬───────────┘   │
└────────────────────────────────────────────────────────┼───────────────┘
                                                         │
                               4. Compile AuthorityIR    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        On-Chain Session Enforcer                       │
│                                                                        │
│   ┌───────────────────┐   5. Grant Session  ┌──────────────────────┐   │
│   │   Altana Smart    │◄────────────────────┤  GuardedExecutor     │   │
│   │     Account       │                     │ (Spend & Call Bounds)│   │
│   └─────────┬─────────┘                     └──────────┬───────────┘   │
│             │                                          │               │
│             │ 6. Execution                             │ 7. Boundary   │
│             ▼                                          ▼    Enforcement│
│   ┌───────────────────┐                     ┌──────────────────────┐   │
│   │ Venus repayBorrow │                     │ UnauthorizedCall /   │   │
│   │    (SUCCESS)      │                     │ ExceededSpendLimit   │   │
│   └───────────────────┘                     └──────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                        8. Independent Verification
                                    ▼
                        ┌────────────────────────┐
                        │      CLI Verifier      │
                        └────────────────────────┘
```

---

## Core Components

### 1. Domain Layer (`packages/domain`)
- Canonical serialization, hashing, schema validation, and state machines.
- Discriminated union schemas for `TrialEvidence`, `StrategyTrialEvidence`, `MandateActivation`, and `Receipt`.

### 2. AuthorityIR & Subset Comparator (`packages/authority-ir`)
- Compiles agent requests into `AuthorityIR` (Intermediate Representation).
- `isSubset(granted, tested)` evaluates set containment over targets, selectors, spend limits, and expiration windows.
- Fails closed: if any granted permission exceeds tested boundaries, compilation returns `NOT_A_SUBSET`.

### 3. Authority Compiler (`packages/authority-compiler`)
- Converts `AuthorityIR` into enforceable Altana session configurations.
- Enforces calendar spend limit alignments and zeroing of transient approvals.

### 4. Altana Adapter (`packages/altana`)
- Manages Smart Account sessions, KeyStore registrations, effective authority reads, and in-product revocation.
- Reads `canExecutePackedInfos` and `spendInfos` directly from chain to surface actual enforced permissions.

### 5. Trial Runner & Reference Models (`services/trial-runner`, `reference/health-factor`)
- Fork-tests agents against real BSC protocols (Venus, StableSwap).
- Evaluates agent proposals against independent reference models that run on pre-state *before* the agent executes.
- Publishes immutable receipts to `MandateReceiptRegistry`.

### 6. Reference Agents (`agents/reference`)
- Eight reference agents across four categories (`HEALTH_FACTOR`, `YIELD`, `GRID`, `REBALANCING`).
- Shared HTTP/JSON-RPC A2A runtime (`packages/agent-runtime`) hosted on Cloudflare Workers (`agents/gateway`).

### 7. Independent Verifier (`apps/verifier`)
- Command-line tool and library that verifies mandates and trials without reading any database or trusting any boolean flag in artifacts.
- Reads the chain, fetches evidence from public IPFS/GitHub, re-hashes documents, re-executes reference models, and re-derives `granted ⊆ tested`.

---

## Security Boundaries & Enforcements

1. **Account Level Enforcement**: Refusals originate from the user's `GuardedExecutor` contract on chain, *not* from a backend server.
2. **Pre-Broadcast Refusal**: Blocked intents (out-of-scope selector, wrong target, spend limit breach) fail account validation before broadcast. They leave no reverted transaction hash on chain.
3. **Owner-Agent Key Separation**: The owner's key grants/revokes sessions; the agent's session key signs executions; the relay broadcasts transactions.

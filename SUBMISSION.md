# MANDATE by winsznx — Hackathon Submission Form Draft

## Project Name
MANDATE by winsznx

## Submitter Details
- **Full Name**: [USER_INPUT]
- **Email**: [USER_INPUT]
- **Telegram**: [USER_INPUT]
- **Twitter / X**: [USER_INPUT]
- **Discord**: [USER_INPUT]
- **Country / Timezone**: [USER_INPUT]
- **Team Members**: [USER_INPUT]
- **Prize Wallet Address**: [USER_INPUT]

## One-Line Pitch
MANDATE is the BNB Agent Studio marketplace where DeFi agents prove a task before users grant them matching onchain authority.

## Project GitHub Repository
https://github.com/winsznx/mandate

## Live Product URL
https://mandate-web.timjosh507.workers.dev

## Finished Mandate Proof URL
https://mandate-web.timjosh507.workers.dev/proof/0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b

## Prototype Stage
Working MVP (Proven end-to-end on BSC Testnet, chain 97)

## Sub-Prize / Partner Track Interests
- [x] **TermiX Agent Advantage Track** (Report filed: `reports/agent-advantage/REPORT.md`)
- [x] **AltLayer Agent Track** (ERC-8004 identity & agent infrastructure)
- [x] **Altana Session & Passkey Track** (Live Altana session proof & account enforcement)
- [ ] **PancakeSwap Track** (Interest track declared; rebalancing built safely on Venus to preserve strict target/selector guards without calldata injection risks)

---

## Detailed Project Description

### 1. Overview
Financial agents today present a binary choice: grant full, unrestricted access to your wallet, or grant nothing. **MANDATE** solves this by enforcing **Trial-Bound Authority**: an invariant where:

$$\text{GrantedEnforceableAuthority} \subseteq \text{TestedEnforceableAuthority}$$

Before an agent receives access to user funds, MANDATE executes the agent against a pinned fork of the real protocol, evaluates its decision against an independent reference model, and records an append-only receipt on chain. The user's Smart Account (powered by Altana) then grants a session key constrained strictly to the target contracts, function selectors, token spend limits, and expiration window tested during the trial.

### 2. Four First-Class Agent Categories (BNB Agent Studio)
MANDATE provides full marketplace depth across all four required BNB Agent Studio categories, with 8 reference agents registered on the ERC-8004 identity registry (`0x8004a818bfb912233c491871b3d84c89a494bd9e`) and hosted on live endpoints:
- **Health Factor Monitoring**: `health-factor-a` (Conservative Guardian), `health-factor-b` (Efficient Guardian) — Flagship proof path on Venus Protocol (`vUSDT.repayBorrow`).
- **Yield Optimisation**: `yield-a` (Cost-Aware Optimizer), `yield-b` (Diversified Optimizer) — Venus supply yield (`vBNB.mint`).
- **Grid Trading**: `grid-a` (Tight Grid), `grid-b` (Wide Grid) — Range-bound execution on Venus / liquidity pairs.
- **Rebalancing**: `rebalancing-a` (Narrow Band Allocator), `rebalancing-b` (Wide Band Allocator) — Target ratio allocation on Venus collateral markets.

### 3. Evidence Quality & Provenance Ladder
Rather than collapsing agent trust into an arbitrary single score, MANDATE classifies evidence into an explicit 6-tier provenance ladder:
1. **Claimed**: Unverified card assertions.
2. **Public Activity**: On-chain history without proof link.
3. **Identity-Bound**: Registered under ERC-8004 with verified HTTP/A2A endpoints.
4. **Trial-Verified**: Fork-tested against independent reference models with on-chain receipts.
5. **Mandate-Native**: Granted active Altana session with on-chain lifecycle.
6. **Mandate-Verified**: Replayed and independently verified by the CLI verifier.

### 4. Account Enforcement & In-Product Revocation
Enforcement occurs on-chain inside the user's Smart Account (`GuardedExecutor`). Out-of-scope calls or spend cap breaches are refused during account validation *before broadcast*, raising `ExceededSpendLimit` or `UnauthorizedCall`. No transaction is broadcast for blocked attempts.
Users can inspect active session status, spend limits, expiry, and revoke authority directly inside the marketplace UI at any time.

### 5. Independent Verification
Anyone can verify any mandate without an account or trusting MANDATE's database:
```bash
pnpm verify:mandate 0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b --chain 97
```
The independent CLI verifier re-reads the chain, re-fetches evidence, re-hashes documents, re-runs the reference model, and recomputes the subset relation.

### 6. Partner Qualifications Summary
- **TermiX**: Filed `reports/agent-advantage/REPORT.md` analyzing 3 real tasks with vs. without agent (automated health factor monitoring saved ~18 minutes and prevented liquidation; yield optimizer improved APY calculation accuracy; grid manager eliminated manual recalculations).
- **Altana**: Implemented native Altana session management, KeyStore registration, spend limits per UTC day, and live browser revocation.
- **AltLayer / ERC-8004**: All 8 reference agents registered on chain on BSC testnet ERC-8004 registry.

### 7. Honest Disclosures & Limitations
- All proofs demonstrated on **BSC Testnet (chain 97)**.
- Blocked actions produce **no reverted transaction** because the user's account contract refuses the intent before broadcast.
- Calldata argument boundaries are not constrained by basic session keys; functions requiring calldata safety (e.g. PancakeSwap router recipient args) are flagged as requiring calldata guards.

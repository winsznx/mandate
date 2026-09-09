# Architectural Decisions Log (DECISIONS)

This document logs critical technical decisions made during the design and implementation of MANDATE.

---

## Decision Index

### B01: Trial-Bound Authority Invariant
- **Decision**: Enforce $\text{GrantedEnforceableAuthority} \subseteq \text{TestedEnforceableAuthority}$ as an absolute compile-time and verifier-checked invariant.
- **Rationale**: Agents must not receive arbitrary permissions. Authority is bounded strictly to what was proven in a reproducible fork trial.

### B02: Pre-Broadcast Refusal vs. On-Chain Reverts
- **Decision**: Reject out-of-scope executions in account validation *before* broadcast.
- **Rationale**: Pre-broadcast refusal prevents gas waste and guarantees that invalid intents never touch the chain. The evidence of refusal is the account state and validator error, not a reverted transaction hash.

### B03: Owner / Agent Key Separation
- **Decision**: Require distinct keypairs for the capital owner (admin/grantor/revoker) and the agent (executor/session signer).
- **Rationale**: An agent must never hold admin authority over an account. The owner must be able to revoke the session unilaterally without agent cooperation.

### B04: Independent Reference Models
- **Decision**: Build reference models completely separate from agent implementations (e.g. `reference/health-factor` vs `agents/reference/health-factor-a`).
- **Rationale**: Prevents shared-code bug masking where a bug in an agent is duplicated in the evaluator and falsely marked as valid.

### B05: UTC Calendar Spend Limit Buckets
- **Decision**: Spend limits follow UTC calendar day buckets rather than 24-hour rolling windows.
- **Rationale**: Aligns with smart account contract spend-limit storage models. Displayed explicitly as "per UTC day" across all UIs.

### B06: ERC-8004 Identity Registration for Reference Inventory
- **Decision**: Register all 8 launch reference agents under ERC-8004 on BSC Testnet.
- **Rationale**: Establishes identity-bound provenance for reference agents without overstating third-party ecosystem size.

### B07: Self-Hosted Cloudflare Workers Gateway
- **Decision**: Host reference agents on Cloudflare Workers via `agents/gateway` rather than ephemeral trial servers.
- **Rationale**: Guarantees 100% uptime for judging evaluation (September 9–23) with fast global RPC response times.

### B08: Honest 6-Tier Provenance Ladder
- **Decision**: Reject single "AI security scores". Categorize evidence into Claimed, Public Activity, Identity-bound, Trial-verified, Mandate-native, and Mandate-verified.
- **Rationale**: Transparently communicates exact evidence depth for every agent and category.

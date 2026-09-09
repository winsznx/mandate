<p align="center">
  <img src="apps/web/public/brand/logo-horizontal.svg" alt="MANDATE Logo" width="320" />
</p>

# MANDATE

**Agents prove the job. You grant only those powers.**

MANDATE is evidence-bound authority for financial agents on BNB Chain. An agent proves a specific financial capability under test against a pinned fork of the target protocol, receives an append-only on-chain receipt, and gets granted a session key restricted strictly to that tested authority. Anything outside that boundary is refused by your own account contract before broadcast.

Not by our server. By the chain.

| | |
|---|---|
| **Live Marketplace** | [https://mandate-web.timjosh507.workers.dev](https://mandate-web.timjosh507.workers.dev) |
| **Verified Mandate** | [`/proof/0xae988cd9…`](https://mandate-web.timjosh507.workers.dev/proof/0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b) |
| **Independent Proof** | `pnpm verify:mandate 0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b --chain 97` |
| **Architecture** | [`docs/architecture.md`](docs/architecture.md) \| [`docs/README.md`](docs/README.md) |

---

## What MANDATE Does

Financial agents today force a bad choice: hand over full, unrestricted access to your wallet, or grant nothing. MANDATE replaces all-or-nothing delegation with **Trial-Bound Authority**.

1. **Trial Execution**: Agent capability is evaluated against a pinned protocol fork.
2. **Independent Replay**: Reference models replay the strategy to produce a verified verdict.
3. **On-Chain Receipt**: Commitments are registered on the `MandateReceiptRegistry`.
4. **Authority Compilation**: Compiles enforceable Altana session keys where `Granted ⊆ Tested`.
5. **On-Chain Enforcement**: Account contracts enforce spend caps & target selectors before broadcast.

---

## Four Agent Job Categories

MANDATE populates 8 reference agents registered under ERC-8004 on BSC Testnet across four core categories:

1. **Health Factor Monitoring** (`HEALTH_FACTOR`): Automated Venus loan defense (`vUSDT.repayBorrow`). Flagship Mandate-verified lifecycle.
2. **Yield Optimisation** (`YIELD`): Venus supply yield optimization (`vBNB.mint`). Trial-verified strategy evidence.
3. **Grid Trading** (`GRID`): Range-bound liquidity management. Trial-verified strategy evidence.
4. **Rebalancing** (`REBALANCING`): Asset band reallocation. Trial-verified strategy evidence.

---

## Verified Example (BSC Testnet)

A Venus health-factor agent was tested, granted a bounded mandate, and executed on chain:

| Dimension | Details |
|---|---|
| Network | BSC Testnet (chain 97) |
| Receipt Registry | [`0x0791af52…`](https://testnet.bscscan.com/address/0x0791af52629206b5434a6865e9e1536a493854ca) (Sourcify Verified) |
| Agent Identity | ERC-8004 `#1842` |
| Tested Authority | Venus `vUSDT.repayBorrow(uint256)`, USDT ≤ 25 per UTC day |
| Granted Authority | Identical target & spend cap, expiring in 45 days |
| Permitted Action | Repaid 20 USDT — succeeded on-chain |
| Cap Breach | +6 USDT attempt refused with `ExceededSpendLimit` |
| Wrong Target | Refused by account contract with `UnauthorizedCall` |

To verify directly from your terminal:

```bash
pnpm install --frozen-lockfile
pnpm verify:mandate 0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b --chain 97
```

---

## Quick Architecture Overview

```
packages/domain            canonical encoding, schemas, hashing, state machines
packages/authority-ir      the subset comparator
packages/authority-compiler  AuthorityIR → enforceable session
packages/altana            session grant/execute/revoke, effective-authority reads
packages/venus-bsc         protocol facts and chain reads only — no risk maths
packages/agent-runtime     shared HTTP/JSON-RPC runtime for the reference agents
reference/health-factor    the independent reference model
agents/reference           eight reference agents, two per category
services/trial-runner      forked-chain trials and evidence
services/authority-proof   end-to-end proof orchestration
apps/verifier              independent CLI verifier
contracts/                 MandateReceiptRegistry Solidity smart contracts
```

---

## Documentation & References

- [**Documentation Index**](docs/README.md)
- [**Architecture & Security**](docs/architecture.md)
- [**Local Setup Guide**](docs/setup.md)
- [**Security Policy**](.github/SECURITY.md)
- [**Protocol Decisions**](docs/decisions.md)
- [**Contributions**](docs/contributions.md)
- [**Submission Facts**](docs/submission.md)
- [**Brand Guidelines**](docs/brand/README.md)

---

## Honest Disclosures & Limitations

- **BSC Testnet Only**: Deployed and verified on BSC Testnet (chain 97).
- **Validation-Time Refusal**: Blocked calls are rejected during pre-broadcast account validation, producing no reverted transaction hash.
- **Session Boundary Scope**: Session keys enforce call target, selector, spend cap, and expiry; calldata parameters require dedicated target guards.
- **No Safety Guarantee**: MANDATE bounds what a session key may execute; it does not guarantee an agent's economic profitability.

---

## License

Apache-2.0

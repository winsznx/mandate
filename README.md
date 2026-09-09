# MANDATE by winsznx

**Find a live agent for this job. See what it proved. Grant only that.**

Financial agents today force a bad choice: hand over full, unrestricted access to your wallet, or grant nothing. **MANDATE** builds the bridge. An agent proves a specific financial capability under test against a pinned fork of the real protocol, receives an append-only on-chain receipt, and gets granted a session key restricted strictly to that tested authority. Anything outside that boundary is refused by your own account contract before broadcast.

Not by our server. By the chain.

| | |
|---|---|
| **Live Marketplace** | [https://mandate-web.timjosh507.workers.dev](https://mandate-web.timjosh507.workers.dev) |
| **Finished Proof** | [`/proof/0xae988cd9…`](https://mandate-web.timjosh507.workers.dev/proof/0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b) |
| **GitHub Repo** | [https://github.com/winsznx/mandate](https://github.com/winsznx/mandate) |
| **Network** | BSC Testnet (chain 97) |
| **Submission Facts** | [`submission-facts.json`](submission-facts.json) \| [`SUBMISSION.md`](SUBMISSION.md) |
| **TermiX Report** | [`reports/agent-advantage/REPORT.md`](reports/agent-advantage/REPORT.md) |
| **Verify from Terminal** | `pnpm install && pnpm verify:mandate 0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b --chain 97` |

---

## The Four Agent Jobs

MANDATE provides full marketplace coverage across four core agent categories, populated by 8 reference agents registered under ERC-8004 on BSC Testnet:

1. **Health Factor Monitoring** (`HEALTH_FACTOR`): Automated Venus loan defense (`vUSDT.repayBorrow`). Flagship Mandate-verified lifecycle.
2. **Yield Optimisation** (`YIELD`): Venus supply yield optimization (`vBNB.mint`). Trial-verified strategy evidence.
3. **Grid Trading** (`GRID`): Range-bound liquidity management. Trial-verified strategy evidence.
4. **Rebalancing** (`REBALANCING`): Asset band reallocation. Trial-verified strategy evidence.

---

## Core Invariant: Trial-Bound Authority

```
GrantedEnforceableAuthority ⊆ TestedEnforceableAuthority
```

```
Trial execution (pinned fork)
      ↓
Independent reference replay        (two implementations, one verdict)
      ↓
Receipt commitment                  (append-only, on chain)
      ↓
AuthorityIR compilation             (granted ⊆ tested, or compile fails)
      ↓
Altana session grant                (target + selector + spend cap + expiry)
      ↓
Permitted execution succeeds        (Venus repayBorrow 20 USDT)
Out-of-scope execution refused      (refused by account contract before broadcast)
      ↓
Independent verification            (verified from chain without trusting server)
```

---

## What is proven, on BNB Smart Chain testnet

A Venus health-factor agent was tested, granted a bounded mandate, and used it.

| | |
|---|---|
| Network | BSC Testnet (97) |
| Receipt registry | [`0x0791af52…`](https://testnet.bscscan.com/address/0x0791af52629206b5434a6865e9e1536a493854ca) — Sourcify-verified |
| Agent | ERC-8004 `#1842` |
| Tested authority | Venus `vUSDT.repayBorrow(uint256)`, USDT ≤ 25 per UTC day |
| Granted authority | identical, expiring in 45 days |
| Permitted action | repaid 20 USDT — succeeded |
| Cap breach | +6 USDT refused with `ExceededSpendLimit` |
| Wrong target / selector | refused with `UnauthorizedCall` |
| Roles | owner [`0xdc507191…`](https://testnet.bscscan.com/address/0xdc5071910e6ca6855d45f96ba28ee0a2e5629299) granted; agent [`0x29f7b991…`](https://testnet.bscscan.com/address/0x29f7b9913dd16278db7a6cfca145953a854ca0dc) signed every execution; the owner revoked without the agent |
| Revocation | session removed from account and KeyStore; the same action then refused |
| Lifecycle | grant window and revocation recorded on chain, so the grant stays reconstructible after the key is gone |

Verify it yourself, with no account and no wallet:

```bash
pnpm install
pnpm verify:mandate <mandateId> --chain 97
```

The verifier reads the registry, fetches the evidence, re-hashes it, re-runs the reference model, recomputes `granted ⊆ tested` with its own comparator, and checks the executions against chain. It never reads our database. It never trusts a boolean in the artifact.

---

## The Strategy-Trial Categories

MANDATE has four agent categories: `HEALTH_FACTOR`, `YIELD`, `GRID`, and `REBALANCING`. The health-factor path above is the one proven end to end, through a granted mandate and an on-chain execution. The other three deliberate and are trial-verified, emitting `StrategyTrialEvidence` (`mandate.strategy-trial-evidence/1`).

The reference agents that populate these categories, two per category, live in [`agents/reference`](agents/reference/README.md).

---

## What is deliberately NOT claimed

Every public claim lives in [`claims/ledger.json`](claims/ledger.json) with its evidence and its proof rung. Five entries are marked `NOT_CLAIMED`, and they matter as much as the verified ones:

- **No mainnet claim.** Everything above is testnet.
- **No third-party agent claim.** The owner and the agent are different keys and the account enforces against the agent's, but both keys are operated by MANDATE.
- **No reverted-transaction claim for blocked actions.** Out-of-scope calls are refused during validation, *before* broadcast, so there is no failed transaction to point at. The evidence is the account's own state at the attempt plus the validator's error.
- **No third-party inventory claim.** Launch inventory is our reference agents.
- **No claim that MANDATE makes agents safe.** It bounds what a session may do. It does not make an agent correct, honest, or competent.

---

## Repository Structure

```
packages/domain            canonical encoding, schemas, hashing, state machines
packages/authority-ir      the subset comparator
packages/authority-compiler  AuthorityIR → enforceable session
packages/altana            session grant/execute/revoke, effective-authority reads
packages/venus-bsc         protocol facts and chain reads only — no risk maths
packages/agent-runtime     shared HTTP/JSON-RPC runtime for the reference agents
reference/health-factor    the independent reference model
agents/reference           eight reference agents, two per category
services/trial-runner      forked-chain trials and evidence, health-factor and strategy
services/authority-proof   the end-to-end proof orchestration
apps/verifier              the independent verifier
contracts/                 MandateReceiptRegistry
reports/                   partner qualification reports (TermiX)
```

For technical details, see:
- [`ARCHITECTURE.md`](ARCHITECTURE.md)
- [`SECURITY.md`](SECURITY.md)
- [`DECISIONS.md`](DECISIONS.md)
- [`CONTRIBUTIONS.md`](CONTRIBUTIONS.md)
- [`SETUP.md`](SETUP.md)

---

## License

Apache-2.0

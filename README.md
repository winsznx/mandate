# MANDATE

**See what an agent proved. Give it only those powers.**

Financial agents today get one of two things: unrestricted access to your wallet,
or nothing. MANDATE builds the bridge. An agent proves a specific financial
capability under test, receives exactly the authority it proved and no more, and
anything outside that boundary is refused by your own account contract.

Not by our server. By the chain.

| | |
|---|---|
| Marketplace | https://mandate-web.timjosh507.workers.dev |
| Finished mandate | [`/proof/0xae988cd9…`](https://mandate-web.timjosh507.workers.dev/proof/0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b) |
| Network | BSC Testnet (chain 97) |
| Verify from a terminal | `pnpm install && pnpm verify:mandate 0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b --chain 97` |
| Status | Core mechanism proven end to end on testnet. Marketplace surface early — see [Status](#status). |

---

## The mechanism

```
Trial execution
      ↓
Independent reference replay        two implementations, one answer
      ↓
Receipt commitment                  append-only, on chain
      ↓
AuthorityIR compilation             granted ⊆ tested, or it does not compile
      ↓
Altana session                      target + selector + spend cap + expiry
      ↓
Permitted execution succeeds
Out-of-scope execution refused      by the account, before broadcast
      ↓
Independent verification            from chain, without trusting us
```

The invariant the whole product rests on:

```
GrantedEnforceableAuthority ⊆ TestedEnforceableAuthority
```

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

The verifier reads the registry, fetches the evidence, re-hashes it, re-runs the
reference model, recomputes `granted ⊆ tested` with its own comparator, and
checks the executions against chain. It never reads our database. It never
trusts a boolean in the artifact.

## The strategy-trial categories

MANDATE has four agent categories: `HEALTH_FACTOR`, `YIELD`, `GRID`, and
`REBALANCING`. The health-factor path above is the one proven end to end,
through a granted mandate and an on-chain execution. The other three deliberate
and are trial-verified, and they stop short of that: a trial runs and an
independent model judges it, but no strategy trial has yet been put on chain,
granted as a mandate, or replayed by the verifier.

A strategy trial differs from the health-factor trial in one place, and the
schema makes the difference explicit rather than papering over it. Both fork the
chain, run the agent against a real market, and judge its proposal against an
independent reference model that ran on the pre-state *before* the agent was
invoked. The health-factor trial emits `TrialEvidence`
(`mandate.trial-evidence/1`), whose reference block commits to a health factor, a
liquidation-threshold-weighted collateral total, and a per-leg exposure table. A
yield, grid, or rebalancing model derives none of those, and emitting them
anyway would read to a verifier as a solvency claim no model made. So a strategy
trial emits `StrategyTrialEvidence` (`mandate.strategy-trial-evidence/1`)
instead, whose reference block states what those models actually compute.
Everything else the two documents share, down to the four questions a verifier
answers from the artifact alone, is shared literally.

The reference agents that populate these categories, two per category, live in
[`agents/reference`](agents/reference/README.md).

## What is deliberately NOT claimed

Every public claim lives in [`claims/ledger.json`](claims/ledger.json) with its
evidence and its proof rung. Five entries are marked `NOT_CLAIMED`, and they
matter as much as the verified ones:

- **No mainnet claim.** Everything above is testnet.
- **No third-party agent claim.** The owner and the agent are different keys and
  the account enforces against the agent's, but both keys are still ours. A
  second keypair is not a second party. What is not yet shown is an agent
  operated by someone else, on capital owned by someone else.
- **No reverted-transaction claim for blocked actions.** Out-of-scope calls are
  refused during validation, *before* broadcast, so there is no failed
  transaction to point at. The evidence is the account's own state at the
  attempt plus the validator's error. That is an earlier and stronger boundary
  than a revert, and it is a different artifact — we describe it as one.
- **No third-party inventory claim.** A 300-agent sample of BSC ERC-8004
  registrations found ~75% bulk-mint entries from a single publisher and three
  with a working endpoint. Launch inventory is our own reference agents.
- **No claim that MANDATE makes agents safe.** It bounds what a session may do.
  It does not make an agent correct, honest, or competent.

## Repository

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
```

`packages/venus-bsc` exports facts; `reference/health-factor` computes risk. The
split is deliberate: a shared `computeHealthFactor()` would let one bug produce a
wrong agent *and* an evaluator that agrees with it. That separation already
caught a real error — see below.

## Findings from building this

Verification against live chains contradicted three assumptions we started with,
and turned up one upstream issue worth reporting:

- **Spend limits are calendar-aligned UTC buckets, not rolling windows.** The
  full limit is spendable at 23:59 and again at 00:01. We say "per UTC day".
- **Session-path ERC-20 approvals are force-zeroed** by the account at the end of
  every batch, so they are not the durable risk. Admin-path approvals and
  ERC-1271 signing paths are.
- **Requested permissions are not enforced permissions.** The wallet stack
  silently appends a wildcard permission for its orchestrator, so MANDATE
  displays authority read back from the account rather than the object it asked
  for.
- **[Reconstructing Venus account risk from `getAssetsIn` can omit debt](contributions/venus-getassetsin/README.md).**
  VAI is not a market and never appears there, so a monitor built that way reads
  a leveraged account as having no debt and never fires. Reproducible from a
  plain RPC today.

## Status

The core authority mechanism is proven end to end on testnet. The marketplace
surface around it is early: all four agent categories deliberate, but only
health-factor is proven through to a granted mandate on chain. The other three
are trial-verified and stop at strategy evidence, with the verifier's strategy
replay path and the consumer-facing flows still being built. The backlog is
tracked privately.

## License

Apache-2.0

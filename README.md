# MANDATE

**See what an agent proved. Give it only those powers.**

Financial agents today get one of two things: unrestricted access to your wallet,
or nothing. MANDATE builds the bridge. An agent proves a specific financial
capability under test, receives exactly the authority it proved and no more, and
anything outside that boundary is refused by your own account contract.

Not by our server. By the chain.

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
| Granted authority | identical, expiring in 24h |
| Permitted action | repaid 20 USDT — succeeded |
| Cap breach | +6 USDT refused with `ExceededSpendLimit` |
| Wrong target / selector | refused with `UnauthorizedCall` |
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

## What is deliberately NOT claimed

Every public claim lives in [`claims/ledger.json`](claims/ledger.json) with its
evidence and its proof rung. Four entries are marked `NOT_CLAIMED`, and they
matter as much as the verified ones:

- **No mainnet claim.** Everything above is testnet.
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
reference/health-factor    the independent reference model
services/trial-runner      forked-chain trial execution and evidence
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

The dominant mechanism is proven end to end on testnet. The marketplace surface
around it is early: one of four agent categories is fully implemented, and the
consumer-facing flows are still being built. The backlog is tracked privately; the short version is that one of four agent
categories is implemented and the consumer-facing flows are still being built.

## License

Apache-2.0

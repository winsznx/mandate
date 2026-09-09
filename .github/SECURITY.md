# Security model

MANDATE bounds what an agent's session may do. It does not make an agent
correct, honest, or competent. This document states what is enforced, what is
merely asserted, and where the boundary genuinely leaks.

## What actually enforces the boundary

Not this application. The user's own account contract.

When an agent submits an action outside its granted authority, the refusal comes
from `GuardedExecutor` inside the account, which raises `ExceededSpendLimit` or
`UnauthorizedCall`. MANDATE's server is not in that path and cannot be made to
be. Compromising MANDATE entirely does not widen a live session.

That is the whole security claim, and it is deliberately narrow.

## What a session can and cannot constrain

The enforcement layer restricts by **call target**, **function selector**,
**per-token spend cap**, and **expiry**. Target and selector are ANDed, and both
are enforced on chain.

It cannot constrain **any calldata argument**. "Send only to me", "swap only into
this token", "cap the per-call size" are inexpressible. This is why a protocol
action whose calldata carries a recipient — every PancakeSwap entry point, Venus
`repayBorrowBehalf` — is classified `GUARD_REQUIRED` and is not granted directly.
The Effective Authority Analyzer makes that determination from deployed bytecode
before any session is designed around a call.

## Three known bypasses, stated plainly

**1. ERC-1271 signing paths.** `signOrder` and x402 payment flows produce account
signatures using the session key. They never pass through the executor, so
neither the call allowlist nor the spend cap applies, and value moves when a
third party submits the authorization later. MANDATE never calls them on a
mandate session. This is a carve-out, not a defence: an agent that obtained the
session key could use them.

**2. Admin-path approvals.** Session-path ERC-20 approvals are force-zeroed by
the account at the end of every batch, so they leave nothing behind. The durable
one is the standing allowance the owner signs so the protocol can pull funds. It
is sized to the mandate's lifetime budget, disclosed as a durable effect, and
cleared on revocation. It survives session revocation until cleared.

**3. Calendar spend buckets.** Spend windows are UTC-aligned buckets with a hard
reset, not rolling windows. The full limit is spendable at 23:59 and again at
00:01. Every interface says "per UTC day" for this reason.

## Requested permissions are not enforced permissions

The wallet stack silently appends a wildcard call permission for its
orchestrator to every session. A session's requested permission object is
therefore not what the chain enforces.

MANDATE reads the enforced set back from the account (`canExecutePackedInfos`,
`spendInfos`) and displays that. Any difference between requested and enforced
is surfaced rather than reconciled. This is a regression fixture, not a
one-time check.

## Trust boundaries

| Party | Trusted for | Not trusted for |
|---|---|---|
| MANDATE | publishing receipts, running trials | enforcing authority, deciding truth |
| The account contract | enforcing target, selector, spend, expiry | anything about agent quality |
| The agent | proposing actions | staying in scope — it is bounded, not believed |
| The evaluator | producing a verdict with its evidence | being correct; the verdict is recomputable |

A centralised evaluator can lie. Every receipt therefore carries the evaluator
version, its code hash, the reference model hash, and the raw evidence, and the
verifier recomputes the verdict rather than reading it.

## Key handling

Session private keys are never written to the database, to logs, to evidence
artifacts, or to any tracked file. `.env` is gitignored and mode 600.

Each proof run derives a fresh session key. KeyStore revocation is monotonic: a
revoked key can never be reactivated, so a reused key would work exactly once.

## Prompt injection

An agent's reasoning is untrusted by construction. Market data can change what an
agent *asks for*; it cannot change what the session *permits*, because the
allowlist and the spend cap live in the account and the agent has no path to
either. Executors in this repo receive a read-only chain client and return a
proposed action; they hold no signer.

## Reporting

Open an issue at `github.com/winsznx/mandate`. This is hackathon-stage software
on testnet and has not been audited.

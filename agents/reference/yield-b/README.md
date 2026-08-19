# Diversified Optimizer (`yield-b`)

**Status: implemented.**

Moves idle stablecoin into the Venus Core-pool markets under a **60% per-market
ceiling**, accepting a lower headline rate rather than concentrating the whole
position in one market. Its sibling
[`yield-a`](../yield-a/README.md) has no ceiling at all.

It proposes. It does not sign, submit, or hold a key.

- Category: `YIELD`
- Skill: `optimise-yield`
- Action: `mint(uint256)` / `0xa0712d68`

## What differs from `yield-a`, and what does not

The deliberation is imported from `@mandate/agent-yield-a` rather than copied.
Two agents in a category are meant to differ in their published risk parameters
and in nothing else, so a reader comparing their receipts is comparing the
parameters. Forking the code would let the two drift apart in ways the cards do
not disclose, and a trial would then certify an undisclosed difference.

| | `yield-a` | `yield-b` |
|---|---|---|
| `policyId` | `cost-aware-optimizer` | `diversified-optimizer` |
| `maxVenueShareBps` | none | **6000** |
| `minNetSupplyRateBps` | 75 | **50** |

The lower rate floor follows from the ceiling rather than being a separate
opinion. An agent that must spread its capital will spend part of it in the
second-best market, so holding out for the same headline rate would leave it
permanently idle.

On a $1500 book with both markets open, the two agents pick the same market and
size it differently: `yield-a` commits the whole $1000 idle USDC balance and this
agent stops at $900. That gap is **1000 bps against a 50 bps evaluator
tolerance**, so an evaluator carrying one policy fails an agent that ran the
other — which is the property that makes a receipt a statement about an agent
rather than about its category.

## The ceiling is measured against total capital

Supplied **plus idle**, not supplied alone. That denominator does not move when
the deployment happens, because supplying converts idle capital into supplied
capital and changes neither total.

Measured against the supplied part instead, the rule cannot be satisfied: on an
account with nothing supplied yet, any first deposit is the whole of the supplied
capital and breaches every ceiling below 10000 bps. A diversification policy that
forbids ever starting is not conservative, it is broken. The reference model
makes the same choice independently and `reference/yield/test/model.test.ts`
pins it.

## Everything else

The protocol facts, the fail-closed behaviour, the decimal trap, the paused-market
and supply-cap filters and the implementation pin are all documented in
[`yield-a`'s README](../yield-a/README.md) and apply here unchanged.

## Tests

```bash
pnpm --filter @mandate/agent-yield-b test
```

`test/strategy.test.ts` runs both agents in the category over one identical state
and asserts they diverge — on the size when both act, and on the decision itself
when only one does.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

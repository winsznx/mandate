# Wide Band Allocator (`rebalancing-b`)

Holds the same published equal-weight allocation across the Venus Core-pool
stablecoin markets as its sibling, and lets it wander 600 bps of the portfolio
before correcting.

- Category: `REBALANCING`
- Skill: `rebalance-allocation`
- Target protocol: Venus Core pool
- Action: `mint(uint256)`, selector `0xa0712d68`

## What it does

The deliberation is imported from `@mandate/agent-rebalancing-a` rather than
copied. This package contributes a policy and nothing else.

That is the honest arrangement for a variant pair: the two agents in a category
are meant to differ in their published risk parameters and in nothing else, so a
reader comparing their receipts is comparing the parameters. Forking the code
would let the two drift apart in ways the cards do not disclose, and a trial
would then be certifying an undisclosed difference.

Published policy:

| Parameter | Value |
|---|---|
| `policyId` | `wide-band-allocator` |
| `targets` | vUSDT 5000 bps, vUSDC 5000 bps |
| `driftTriggerBps` | 600 |
| `minRebalanceUsdMantissa` | 10e18 (USD) |
| `amountToleranceBps` | 50 |

## What the band buys and what it costs

The destination is identical to the Narrow Band Allocator's. Only the tolerance
for being away from it differs, which is what makes a side-by-side receipt a
comparison of two policies rather than a reconciliation of two unrelated
mandates.

A wider band means fewer transactions and less gas drag, and a portfolio that
spends more of its life away from the weights it advertises. The two agents
diverge on the decision itself: on a $1000 book whose USDC leg is $10 short —
exactly 100 bps — the narrow band mints and this agent holds. That is a
difference no `amountToleranceBps` can absorb, because on this side there is no
amount at all, so an evaluator carrying one policy cannot certify an agent that
ran the other.

Once the drift is past both bands the two propose the same call. The band
decides whether to act; it does not decide how much.

## The limitation: top-up only, inherited with the strategy

This agent tops up an under-weight market with `mint(uint256)` and never reduces
an over-weight one. Reducing one means `redeemUnderlying(uint256)`, selector
`0x852a12e3`, and that action is withheld.

The reason is worth stating exactly, because the obvious one is wrong.
`redeemUnderlying` carries no address argument, so its *reach* is bounded by
`(target, selector)` exactly as `mint`'s is.
`internal/research/00-DECISIONS.md` §1.4 classifies it `GUARD_REQUIRED` for a
different reason: withdrawing collateral lowers borrowing power and can drive a
borrowing account's health factor below one, into self-liquidation. No
`(target, selector, spend cap)` triple can express a health-factor floor,
because a spend cap counts tokens and a health factor is a function of the whole
account.

So when a gap can only be closed by taking from the over-weight side, this agent
holds and names the function it would have needed. It meets that case less often
than its sibling, because it acts less often, and it refuses in the same words
when it does. The limitation belongs to the authority, not to the band.

## The independent model that judges it

`reference/rebalancing` judges both agents in the pair and shares no financial
code with either. It carries its own copy of the drift predicate, values
positions by a different route, and reads each market's supplied total off the
balance sheet rather than from the vToken supply. The shared dependency set
between the model and this package is exactly `["@mandate/domain", "viem"]`, and
`reference/rebalancing/test/independence.test.ts` asserts it in both directions.

## Running it

```bash
pnpm --filter @mandate/agent-rebalancing-b start
```

See `agents/reference/README.md` for the shared runtime contract, environment
variables and the deployment convention.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

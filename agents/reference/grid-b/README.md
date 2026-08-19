# Wide Grid (`grid-b`)

**Status: implemented.**

Runs a **100 bps grid ladder four rungs deep** on the same Curve-style
stableswap pool its sibling trades, ignoring the small dislocations
[`grid-a`](../grid-a/README.md) acts on and holding a much smaller inventory
swing.

It proposes. It does not sign, submit, or hold a key.

- Category: `GRID`
- Skill: `run-grid`
- Target: stableswap-NG pool `0x157b06e4d9501071a401234f117edee913217833`
- Action: `exchange(int128,int128,uint256,uint256)` / `0x3df02124`

## What differs from `grid-a`, and what does not

The deliberation is imported from `@mandate/agent-grid-a` rather than copied.
Two agents in a category are meant to differ in their published risk parameters
and in nothing else, so a reader comparing their receipts is comparing the
parameters.

| | `grid-a` | `grid-b` |
|---|---|---|
| `policyId` | `tight-grid` | `wide-grid` |
| `spacingBps` | 25 | **100** |
| `levels` | 8 | **4** |
| `inventoryStepBps` | 250 | **500** |
| `maxSlippageBps` | 30 | **50** |

The looser slippage bound follows from the wider rungs rather than being a
separate opinion. An agent that only trades a market already a full percent out
of line is trading a market that is *moving*, and holding out for its sibling's
execution would leave it reverting rather than trading.

With the pool 62 bps below fair the two disagree about whether to act at all —
rung 2 on a 25 bps ladder, rung 0 on a 100 bps one. That is the strongest form
the divergence can take, and `test/strategy.test.ts` pins it: an evaluator that
could not separate the two would be measuring the category rather than the agent.

## Everything else

The venue, the boundability argument and its executed evidence, the ladder
model, the rate-adjusted fair rate, the independent invariant reconstruction and
the fail-closed behaviour are all documented in
[`grid-a`'s README](../grid-a/README.md) and apply here unchanged.

## Tests

```bash
pnpm --filter @mandate/agent-grid-b test
```

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

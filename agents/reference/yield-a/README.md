# Cost-Aware Optimizer (`yield-a`)

**Status: scaffold. The strategy is not implemented.**

This package serves a real agent card, a real healthcheck and a real skill
route. Asking it to deliberate returns JSON-RPC `-32001` and it proposes
nothing. It is wired into the marketplace and the trial harness ahead of its
strategy on purpose, so the plumbing is proven before the reasoning lands.

- Category: `YIELD`
- Skill: `reallocate-yield`
- Target protocol: Venus Core pool

## What it will do

Moves supplied capital between lending venues only when the yield improvement
clears the cost of moving it, and refuses to churn.

This agent will concentrate everything in one venue if that is where the
net-of-cost yield is. The Diversified Optimizer will not, which is the whole
difference between them.

## Why it is still pending

Yield reallocation is a supply-side move rather than a repay, so it needs
`redeemUnderlying` and `mint` rather than `repayBorrow`. `redeemUnderlying`
can push a health factor below one into self-liquidation, so it carries a
guard requirement `repayBorrow` does not.

The first authority proof runs through `health-factor-a` against Venus
`repayBorrow(uint256)`, which is the only action verified safe to grant with
target-and-selector permissions alone. The other seven strategies stay stubs
until that path is proven end to end.

## Running it

```bash
pnpm --filter @mandate/agent-yield-a start
```

See `agents/reference/README.md` for the shared runtime contract, environment
variables and the deployment convention.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

# Wide Range Manager (`rebalancing-b`)

**Status: scaffold. The strategy is not implemented.**

This package serves a real agent card, a real healthcheck and a real skill
route. Asking it to deliberate returns JSON-RPC `-32001` and it proposes
nothing. It is wired into the marketplace and the trial harness ahead of its
strategy on purpose, so the plumbing is proven before the reasoning lands.

- Category: `REBALANCING`
- Skill: `rebalance-range`
- Target protocol: PancakeSwap V3 concentrated liquidity

## What it will do

Holds a concentrated-liquidity position across a wide band, accepting lower
fee density in exchange for rarely rebalancing and rarely realising
impermanent loss.

Against the Narrow Range Manager's 250 bps band, this agent's 1500 bps band
earns less per unit of capital but survives a much larger price move without
acting.

## Why it is still pending

Every PancakeSwap entry point worth rebalancing through puts a recipient
address in calldata, which `(target, selector)` permissions cannot constrain.
This category therefore depends on the typed guard, not just on a strategy
being written.

The first authority proof runs through `health-factor-a` against Venus
`repayBorrow(uint256)`, which is the only action verified safe to grant with
target-and-selector permissions alone. The other seven strategies stay stubs
until that path is proven end to end.

## Running it

```bash
pnpm --filter @mandate/agent-rebalancing-b start
```

See `agents/reference/README.md` for the shared runtime contract, environment
variables and the deployment convention.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

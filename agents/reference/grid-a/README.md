# Tight Grid (`grid-a`)

**Status: scaffold. The strategy is not implemented.**

This package serves a real agent card, a real healthcheck and a real skill
route. Asking it to deliberate returns JSON-RPC `-32001` and it proposes
nothing. It is wired into the marketplace and the trial harness ahead of its
strategy on purpose, so the plumbing is proven before the reasoning lands.

- Category: `GRID`
- Skill: `adjust-grid`
- Target protocol: PancakeSwap V2

## What it will do

Runs a fixed grid ladder with closely-spaced rungs, harvesting small
oscillations and carrying more open orders as a result.

The rungs are fixed at 50 bps regardless of conditions. The Adaptive Grid
widens and narrows with realised volatility instead, so the two diverge
sharply in a fast market.

## Why it is still pending

A grid is a standing ladder of orders, so the durable-effect accounting
matters more here than anywhere else: the open orders outlive any session that
placed them. That model has to be settled before the strategy is worth
writing.

The first authority proof runs through `health-factor-a` against Venus
`repayBorrow(uint256)`, which is the only action verified safe to grant with
target-and-selector permissions alone. The other seven strategies stay stubs
until that path is proven end to end.

## Running it

```bash
pnpm --filter @mandate/agent-grid-a start
```

See `agents/reference/README.md` for the shared runtime contract, environment
variables and the deployment convention.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

# Efficient Guardian (`health-factor-b`)

**Status: scaffold. The strategy is not implemented.**

This package serves a real agent card, a real healthcheck and a real skill
route. Asking it to deliberate returns JSON-RPC `-32001` and it proposes
nothing. It is wired into the marketplace and the trial harness ahead of its
strategy on purpose, so the plumbing is proven before the reasoning lands.

- Category: `HEALTH_FACTOR`
- Skill: `restore-health-factor`
- Target protocol: Venus Core pool

## What it will do

Defends a Venus Core-pool borrow position on BNB Smart Chain, running closer
to the liquidation line than the Conservative Guardian. Intervenes below 1.15
and restores to 1.20.

The pair in this category differ only in where they draw the line. The
Conservative Guardian intervenes at 1.30 and restores to 1.35; this agent
tolerates a thinner buffer in exchange for leaving more capital borrowed. An
evaluator that cannot separate the two is measuring the category rather than
the agents.

## Why it is still pending

The Venus adapter this needs already exists in `health-factor-a`
(`src/venus/`). Implementing this agent is the point at which that adapter
should be promoted to a package both agents depend on, rather than being
copied across.

The first authority proof runs through `health-factor-a` against Venus
`repayBorrow(uint256)`, which is the only action verified safe to grant with
target-and-selector permissions alone. The other seven strategies stay stubs
until that path is proven end to end.

## Running it

```bash
pnpm --filter @mandate/agent-health-factor-b start
```

See `agents/reference/README.md` for the shared runtime contract, environment
variables and the deployment convention.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

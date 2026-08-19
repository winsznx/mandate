# Reference agents

Eight self-hosted agents, two per marketplace category, built from the BNB Agent
Studio scaffold and self-hosted by the MANDATE team. BNB does not operate them.

| Package | Name | Category | Skill | Strategy |
|---|---|---|---|---|
| `health-factor-a` | Conservative Guardian | `HEALTH_FACTOR` | `restore-health-factor` | **implemented** |
| `health-factor-b` | Efficient Guardian | `HEALTH_FACTOR` | `restore-health-factor` | **implemented** |
| `rebalancing-a` | Narrow Band Allocator | `REBALANCING` | `rebalance-allocation` | **implemented** |
| `rebalancing-b` | Wide Band Allocator | `REBALANCING` | `rebalance-allocation` | **implemented** |
| `grid-a` | Tight Grid | `GRID` | `run-grid` | **implemented** |
| `grid-b` | Wide Grid | `GRID` | `run-grid` | **implemented** |
| `yield-a` | Cost-Aware Optimizer | `YIELD` | `optimise-yield` | **implemented** |
| `yield-b` | Diversified Optimizer | `YIELD` | `optimise-yield` | **implemented** |

All eight now deliberate. `health-factor-b` was the last scaffold, and until it
landed it served a real card, a real healthcheck and a real skill route and
refused to deliberate on the wire. The runtime keeps that path — `pendingStrategy`
and JSON-RPC `-32001` — because the next agent added here should be discoverable
before its strategy is written, and because an unwritten strategy has to say so
instead of returning something plausible.

The four categories are not equally deep, and the marketplace should not pretend
otherwise. `health-factor-a` is the flagship: it is the action MANDATE's first
authority proof runs through, and its evidence document carries a full solvency
reconstruction. The other three categories are honestly **Trial-verified** —
each has a strategy, an independent reference model that reaches its own
conclusion by its own route, an evaluator that holds no opinion, and a
deterministic scenario built from frozen live-chain readings — and they publish
`StrategyTrialEvidence` rather than `TrialEvidence`, because their models derive
none of the solvency quantities that document commits to. That is MANDATE's own
evidence taxonomy applied to itself rather than papered over.

The actions differ in what they can be granted, and each agent's README states
which:

| Category | Action | Boundable by `(target, selector, spend cap)` alone |
|---|---|---|
| `HEALTH_FACTOR` | `repayBorrow(uint256)` `0x0e752702` | yes — and it can only reduce a liability |
| `YIELD` | `mint(uint256)` `0xa0712d68` | yes — no address in calldata |
| `REBALANCING` | `mint(uint256)` `0xa0712d68` | yes for the top-up leg; the withdraw leg needs a guard |
| `GRID` | `exchange(int128,int128,uint256,uint256)` `0x3df02124` | yes — but `min_dy` is calldata-controlled, so the agent's own slippage bound is the whole mitigation |

## The architecture rule

**An agent proposes. It never executes.**

`AgentExecutor.propose` returns a `ProposedAction` — `{ target, selector, args,
rationale }` — and the deterministic layer decides whether to encode and submit
it. No agent holds a session key, a signer or an RPC write path. The chain
client the runtime hands out is a viem `PublicClient`, so there is no signer to
construct even by accident.

This is the load-bearing rule of the threat model. An agent, and in particular
anything an LLM influences, must never be the thing that determines authority.
`ProposedAction` maps one-to-one onto an `AuthorityIR` call, so what an agent
asks for is expressed in exactly the vocabulary the subset comparator checks.

## Shared runtime

Everything except the strategy lives in `packages/agent-runtime`:

- the HTTP server and its routes
- the `/.well-known/agent-card.json` document and `agentCardHash`
- JSON-RPC `message/send` decode and the proposal encode
- the error taxonomy
- structured logging
- the healthcheck
- the read-only chain client

It sits in `packages/` rather than `agents/reference/_runtime` because it is a
library rather than a reference agent, and because `agents/reference/*` is both
a pnpm workspace glob and the list of the eight. A ninth entry there that is not
an agent would need filtering out of every glob that walks the directory.

## Wire protocol

| Route | Purpose |
|---|---|
| `GET /.well-known/agent-card.json` | discovery |
| `GET /healthz` | platform healthcheck |
| `GET /ping` | liveness alias, AgentCore's convention |
| `POST /` | JSON-RPC 2.0 `message/send` |

The envelope matches the A2A capture in `internal/research/02-bnb-agent-studio.md`
§4.3, so MANDATE's adapter reaches a reference agent through the same code path
it uses for a third-party one. JSON-RPC is at the root because that is where the
Studio scaffold puts it — and because the card advertises `url`, so a correct
client reads the path rather than assuming one.

```bash
curl -sX POST http://localhost:9000/ -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"message/send",
  "params":{"message":{"kind":"message","role":"user","messageId":"1",
    "parts":[{"kind":"data","data":{
      "skill":"restore-health-factor",
      "wallet":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}}]}}}'
```

A decision to do nothing comes back as a normal result with `"decision":"HOLD"`,
not as an error. Faults are errors. An agent that correctly declines to act has
not failed, and a trial record that conflates the two is wrong about the agent.

### Error codes

| Code | Meaning |
|---|---|
| `-32700` | malformed JSON (HTTP 400) |
| `-32600` | bad envelope shape (HTTP 400) |
| `-32601` | method other than `message/send` |
| `-32602` | unknown skill, or a missing/invalid data part |
| `-32603` | internal fault |
| `-32001` | **strategy not implemented** — MANDATE's addition |

`-32001` exists because upstream has no code for "declared but unwritten", and
folding it into `-32603` would make an honestly-scaffolded agent look broken.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `9000` | Railway injects this; the default matches the Studio scaffold's A2A port |
| `HOST` | `0.0.0.0` | Do not set `127.0.0.1`. The process starts, serves nothing to the platform, and fails its healthcheck silently |
| `AGENT_PUBLIC_URL` | `http://localhost:$PORT` | Advertised as the card's `url`. Set it to the public hostname |
| `CHAIN_ID` | `97` | BSC testnet. `health-factor-a` refuses a request naming any other chain |
| `RPC_URL` | `https://bsc-testnet-rpc.publicnode.com` | |
| `RPC_FALLBACK_URL` | `https://data-seed-prebsc-1-s1.bnbchain.org:8545` | Empty string disables the fallback |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

`AGENT_PUBLIC_URL` does not affect `agentCardHash`: the hash strips `url`, so
redeploying behind a new hostname does not supersede a trial.

## Deployment (Railway)

One service per agent, all from the same Dockerfile.

- **Build**: Dockerfile at `agents/reference/Dockerfile`, build context the
  repository root. A workspace package cannot be installed without the root
  manifest and lockfile, so a per-agent root directory will not build.
- **Build arg**: `AGENT=<slug>`, e.g. `AGENT=health-factor-a`.
- **Healthcheck path**: `/healthz`.
- **Port**: leave `PORT` to Railway. The container binds `0.0.0.0:$PORT`.
- **Variables**: `AGENT_PUBLIC_URL` set to the generated domain, plus any RPC
  overrides.

```bash
docker build -f agents/reference/Dockerfile \
  --build-arg AGENT=health-factor-a -t mandate/health-factor-a .
docker run --rm -p 9000:9000 \
  -e AGENT_PUBLIC_URL=http://localhost:9000 mandate/health-factor-a
```

Node only. These containers read chain state over JSON-RPC and never fork,
simulate or sign, so Foundry and Anvil are not installed and are not needed.

`SIGTERM` and `SIGINT` close the server before exit, so a redeploy does not kill
an in-flight deliberation.

## Agent version identity

There is no build identifier upstream. Agent cards and MCP servers hardcode
`"1.0.0"` in every template and never bump it, and every ERC-8004 `built_with`
probe on BSC returned empty. The card emits `"1.0.0"` for compatibility and
flags `versionIsAuthoritative: false` next to it.

MANDATE binds trials to the composite `agentVersionHash` instead. These agents
contribute `cardHash` via `agentCardHash(card)`, which hashes the card with
`url` stripped — every field that describes behaviour stays in the preimage, so
editing a skill description or a policy number supersedes the trial that
certified the previous build.

## Local development

```bash
pnpm --filter @mandate/agent-health-factor-a start   # or dev, for watch mode
pnpm --filter @mandate/agent-health-factor-a test
pnpm --filter @mandate/agent-health-factor-a typecheck
```

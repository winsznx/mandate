# Tight Grid (`grid-a`)

**Status: implemented.**

Runs a **25 bps grid ladder eight rungs deep** on a Curve-style stableswap pool
on BSC testnet 97, harvesting small dislocations and carrying a larger inventory
swing as a result. Its sibling [`grid-b`](../grid-b/README.md) runs 100 bps rungs
four deep.

It proposes. It does not sign, submit, or hold a key. See
`agents/reference/README.md` for the runtime contract and the deployment
convention.

- Category: `GRID`
- Skill: `run-grid`
- Target: stableswap-NG pool `0x157b06e4d9501071a401234f117edee913217833`
  (wstETH/mstETH)
- Action: `exchange(int128,int128,uint256,uint256)` / `0x3df02124`

## Why a grid can be granted at all

`00-DECISIONS.md` §3.2 says every PancakeSwap entry point puts a recipient in
calldata, and defers this whole category to the typed guard. That is true of
every V2 and V3 router path — all **seventeen** state-changing entries in the V2
router's dispatch table take an `address to` — and it is not true of the
Curve-derived stableswap surface, which the report did not cover.

`exchange(int128,int128,uint256,uint256)` is 132 bytes of calldata: the selector
and four integer words. Two coin indices, an input amount, a minimum output.
There is **no address field**. The coin pair is pinned by the pool address the
permission names, and the pool credits the output to `msg.sender` from its own
code, so `(target, selector)` is a complete description of what the call can
reach.

Executed on a fork of chain 97 at block 125932679: `exchange(0, 1, 1e18, 0)`
returned status 1, credited the caller 1158019126116580062 mstETH, and left an
uninvolved third address at zero. In the same session, from the same account,
the five-argument sibling `exchange(int128,int128,uint256,uint256,address)` /
`0xddc1f59d` credited `0x…deadbeef` instead. **One calldata word is the whole
distance between an action MANDATE can bound and one it cannot**, which is why
the agent card names the signature rather than the verb.

### What it can still cost

`min_dy` is calldata-controlled. A session proposing zero would be inside its
mandate and would still hand the account to the first searcher who noticed. That
is a value-loss channel bounded by the standing allowance and the Altana spend
window rather than an exfiltration channel, which puts this action between Venus
`repayBorrow` — which can only reduce a liability — and anything that takes a
recipient. **The agent's own slippage bound is the whole of the mitigation**,
which is why the policy publishes `maxSlippageBps` and the evaluator compares it.

## Why this pool

It is the only venue found on chain 97 with both real balanced depth and a
boundable entry point. At block 125936215 it held 11000.09 wstETH against
10999.90 mstETH with a virtual price of 1.000000004561277297.

The PancakeSwap V2 pairs a grid would otherwise use are unusable. The WBNB/USDT
pair holds **0.1 WBNB** against a USDT reserve seeded as though the token were
18 decimals; the USDT/USDC pair last traded two years before head at a ratio of
**11,124:1** on a pegged pair. Either would produce a nonsense price series.

The pool was reached by walking `PancakeSwap SmartRouter.stableSwapFactory()`
into its pair list rather than guessed at, and reports `version() == "v7.0.0"`.

## The ladder has no open orders

A grid is usually a standing set of orders, which is why this scaffold was
originally blocked on durable-effect accounting: orders outlive the session that
placed them, and a trial cannot evaluate state it cannot see.

This ladder is a **function from price to target inventory**. The agent's entire
durable state is the account's own two token balances, which a trial reads
directly at the fork block. Nothing survives between sessions that the chain does
not already say.

Positions and targets are measured as a share of **rate-adjusted** inventory
rather than in units of either coin, so the ladder does not have to pick a
denominating coin and does not drift as the rate spread widens.

## The rungs centre on fair, not on parity

Both coins are liquid-staking tokens whose redemption values have drifted **16%
apart**. A ladder anchored at 1:1 would sit permanently on one side of the market
and buy the same coin forever.

Fair is `stored_rates[0] / stored_rates[1]`, the price at which the invariant
considers the pool balanced. The agent reads the pool's own `get_dy` at the
published probe size, compares it against fair, and converts the gap into a rung
index.

The probe size is published because **on a curve, price depends on size**: "the
price" is only defined once a size is fixed, and both the agent and the model
judging it have to measure the same thing.

## How the independent model disagrees with it

The agent asks the pool. The reference model in `reference/grid/` refuses to
ask: it solves the invariant D by Newton's method from balances, rate
multipliers and amplification, solves for the post-trade balance by Newton again,
applies the off-peg fee, and arrives at the same number by a completely different
route.

Reproduced wei for wei against the deployed pool at block 125936215:

```
get_dy(0, 1, 1e18)   chain 1158021437469978502   model 1158021437469978502
get_dy(1, 0, 1e18)   chain  863367093084179311   model  863367093084179311
```

Three details in that reconstruction are load-bearing, and
`reference/grid/test/invariant.test.ts` pins each by showing what breaks without
it: the invariant runs on **rate-adjusted** balances, `A()` must be multiplied
back by `A_PRECISION`, and the fee is scaled by `offpeg_fee_multiplier` rather
than charged flat.

## The adaptive ladder that is not here

The scaffold this replaced described spacing that tracked realised volatility.
That is **not implemented**, for a stated reason rather than as an omission:
realised volatility needs a price history, the only history this pool exposes is
an exponential moving average with an 866-second half-life, and a "volatility"
derived from a single EMA reading would be a number with a plausible name and no
content. The pair therefore differ on rung geometry, which is a real risk
parameter both sides can compute from state the chain actually publishes.

## When it holds

- the pool's code no longer hashes to the pin, when one is configured
- part of the pool state could not be read — a curve priced from a subset of its
  own balances is the price of a different pool, not a worse estimate of this one
- a coin reports different decimals than configured
- the price is inside the current rung, or the inventory already matches the
  ladder's target
- the account holds neither coin
- the tranche exceeds the balance or the allowance behind it
- the pool would not quote the trade, so `min_dy` cannot be set

## Live behaviour

At block 125936215 the pool sits **15 bps below fair**, inside the first rung of
both agents in this category. That is a legitimate hold and it is pinned as a
test: an agent that traded it would be churning.

## Tests

```bash
pnpm --filter @mandate/agent-grid-a test
```

`test/strategy.test.ts` covers both trade directions, the rung boundary at
exactly the published spacing, the level clamp, the slippage bound, and one
refusal each for an unquotable trade, a missing allowance, an undersized balance,
an unreadable pool, a decimals disagreement and a changed code hash.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

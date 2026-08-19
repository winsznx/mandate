# Cost-Aware Optimizer (`yield-a`)

**Status: implemented.**

Moves idle stablecoin into the Venus Core-pool market paying the best rate, and
only when that rate clears the cost of moving it. It concentrates without limit:
where the best net rate is, the capital goes. Its sibling
[`yield-b`](../yield-b/README.md) holds a per-market ceiling instead.

It proposes. It does not sign, submit, or hold a key. See
`agents/reference/README.md` for the runtime contract and the deployment
convention.

- Category: `YIELD`
- Skill: `optimise-yield`
- Targets: Venus vUSDT `0xb7526572ffe56ab9d7489838bf2e18e3323b441a`, vUSDC
  `0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7`, vBUSD
  `0x08e0a5575de71037ae36abfafb516595fe68e5e4`
- Action: `mint(uint256)` / `0xa0712d68`

## Why this action

`mint` takes one `uint256`. The vTokens are credited to `msg.sender` from
protocol storage and the underlying is pulled from `msg.sender` by
`transferFrom`, so neither leg of the transfer is reachable from calldata and
`(target, selector)` is a complete description of what the call can touch. That
is the same property that makes `repayBorrow` the first action MANDATE proved.

Verified by execution on a fork of chain 97 at block 125929412. From a funded
account, `vUSDT.mint(500000000)` returned status 1 with calldata that is exactly
the selector and the amount; the caller's USDT went from 1000000000 to
500000000, the caller's vUSDT balance rose from 0 to 2490331760957, and an
uninvolved second account's vUSDT balance stayed at 0. `vUSDC.mint(400000000)`
behaves the same way.

`mintBehalf(address,uint256)` / `0x23323e03` is present in the same
implementation and takes an arbitrary beneficiary. It is never proposed and
never granted, which is why the agent card names the signature rather than the
verb.

### What `mint` can still cost

It cannot move funds anywhere the user does not already control, and it can lock
them. The way back out is `redeemUnderlying(uint256)` / `0x852a12e3`, which the
session is not granted: it carries no address argument, so it is bounded in
*reach*, but `00-DECISIONS.md` §1.4 classifies it `GUARD_REQUIRED` because
withdrawing collateral can drive a borrowing account's health factor below one,
and no `(target, selector, spend cap)` triple can express a health-factor floor.
The admin key can always redeem; a compromised session cannot.

## The rate comparison

`vToken.supplyRatePerBlock()` / `0xae9d70b0`, annualised simply by the
`blocksPerYear` the policy publishes, and expressed in basis points.

That constant is a **stated convention, not a chain reading**. Venus's
interest-rate model on chain 97 sits behind a proxy that reverts on
`blocksOrSecondsPerYear()`, so there is nothing to read, and BSC's block
interval has moved from 3 s to 0.75 s within the life of this deployment. The
policy publishes 10,000,000 so that a reader can see which convention produced
the figure on the proof page — and so the reference model can be handed the same
one, because a comparison between two sides using different conventions would be
measuring the conventions.

The independent reference model never annualises. It converts the policy's floor
*down* into the smallest per-block rate that satisfies it and compares the raw
readings. The two predicates are provably identical — `floor(x) >= K` is
equivalent to `x >= K` for integer `K` — so they cross the line at the same
reading rather than merely near it, and a disagreement between them is a bug
rather than a rounding artefact.

## Markets that will not take a deposit

Three readings decide availability, and leaving any of them out produces a
proposal that reverts rather than one that is merely suboptimal.

- `Comptroller.actionPaused(market, 0)` / `0xe85a2960`, where `MINT` is 0.
  Testnet vBUSD is a **listed, priced market with mint paused**. Filtering on
  `isListed` alone proposes into it, and its fixture rate is deliberately the
  highest on the board so the test catches an agent that does.
- `Comptroller.supplyCaps(market)` / `0x02c3bcbb`. A cap of **zero means the
  market accepts nothing**, which is how Venus writes down a retired market.
  Reading it as "no ceiling" opens exactly the markets the field exists to close.
- `underlying.allowance(account, vToken)`. `mint` pulls with `transferFrom`, and
  the approval is signed by the account's **admin key, never by the session**, so
  it is a precondition the agent checks rather than one it can create.

## The decimal trap

Both testnet stablecoin mocks are **6 decimals**; BSC mainnet USDT is 18. Venus
scales `getUnderlyingPrice` by `1e(36 - underlyingDecimals)`, so the decimals
live inside the price and a wrong value is twelve orders of magnitude out, not
slightly wrong.

The configured value sets the oracle scale; `decimals()` is read as well and the
agent holds when the two disagree. `assertPlausiblePrice` then rejects a price
that cannot be right for the decimals it was read with.

The testnet oracle prices USDT at **$0.50** and USDC at **$1.00**. Nothing here
assumes a peg, and the two prices are why the minimum deployment size is a dollar
floor rather than a token-count floor: fifteen USDC clears a $10 floor and
fifteen USDT does not.

## Implementation pinning

All three markets are `VBep20Delegator` proxies sharing one implementation at
`0x73ff75092da265b87b25ffb943c47c90419a04a6`. `vToken.admin()` is a governance
timelock that can replace it. The agent reads `implementation()` on every market
it considers and holds if any has moved, because the authority analysis the
policy rests on is an analysis of that bytecode.

## When it holds

- a market's implementation is not the audited one
- any market could not be fully read — an unreadable market might have been the
  best one, and ranking the rest answers a different question
- a token reports different decimals than the agent was configured with
- an oracle price is implausible for its decimals
- no market accepting supply has both idle capital and an allowance behind it
- the best net rate is below the floor
- the deployable size is below the minimum deployment value

## Tests

```bash
pnpm --filter @mandate/agent-yield-a test
```

`test/strategy.test.ts` covers the ranking, the boundary at exactly the published
rate floor, the dollar-denominated size floor across two differently-priced
6-decimal tokens, the paused-market and supply-cap filters, allowance sizing, and
one refusal each for a moved implementation, an unreadable market, a decimals
disagreement and an implausible price.

The independent reference model and the architectural invariant it rests on are
in `reference/yield/`.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

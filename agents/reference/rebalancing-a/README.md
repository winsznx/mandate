# Narrow Band Allocator (`rebalancing-a`)

Holds a published equal-weight allocation across the Venus Core-pool stablecoin
markets on BSC testnet 97, and corrects it as soon as a market falls 100 bps of
the portfolio behind its target.

- Category: `REBALANCING`
- Skill: `rebalance-allocation`
- Target protocol: Venus Core pool
- Action: `mint(uint256)`, selector `0xa0712d68`

## What it does

Reads every configured market at one block, values the account's supplied
position in each, and measures each position against the weight the policy
publishes. The portfolio total is supplied capital plus idle wallet capital
across the configured markets, so a dollar the account holds anywhere is a
dollar the allocation has to account for.

When the market furthest below its target has fallen at least a full drift
trigger behind, it proposes a `mint(uint256)` that tops that market up out of
idle wallet capital. The size is the smallest of the dollar gap, the idle
balance, the ERC-20 allowance and the market's remaining supply cap. It
proposes; it never signs, submits or holds a key.

Published policy:

| Parameter | Value |
|---|---|
| `policyId` | `narrow-band-allocator` |
| `targets` | vUSDT 5000 bps, vUSDC 5000 bps |
| `driftTriggerBps` | 100 |
| `minRebalanceUsdMantissa` | 10e18 (USD) |
| `amountToleranceBps` | 50 |

The weights sum to 10000 or the policy refuses to construct. Weights summing to
anything else are not a slightly odd allocation, they are an incoherent one, and
neither failure mode announces itself in the output.

## Why the action is grantable with no guard

`mint(uint256)` takes one `uint256` and nothing else. The vTokens are credited
to `msg.sender` from protocol storage and the underlying is pulled from
`msg.sender` by `transferFrom`, so neither leg of the transfer is reachable from
calldata and `(target, selector)` is a complete description of what the call can
touch. A spend cap on the underlying bounds the rest.

The selector is present in the pinned implementation
`0x73ff75092da265b87b25ffb943c47c90419a04a6`, whose runtime bytecode is 24,250
bytes and byte-identical in codehash to the mainnet `VBep20Delegate`. Verified
on a fork of chain 97 at block 125929412: `vUSDT.mint(500000000)` from a funded
account returned status 1, moved the caller's USDT from 1000000000 to 500000000,
raised the caller's vUSDT balance from 0 to 2490331760957, and left an
uninvolved second account's vUSDT balance at 0.

`mintBehalf(address,uint256)` is on the same contract and takes an arbitrary
beneficiary. It is never granted, which is why the agent card names the
signature rather than the verb.

The agent reads `implementation()` on every market it considers and holds if any
has moved off the pin. `vToken.admin()` is a governance timelock that can
replace the code behind the proxy, so "bounded by target plus selector" is only
as strong as that check.

## The limitation: this agent rebalances by top-up only

A portfolio can be pulled back towards its weights two ways — add to the
under-weight side, or take from the over-weight side — and only the first is
reachable here.

Taking from the over-weight side means `redeemUnderlying(uint256)`, selector
`0x852a12e3`, present in the same pinned implementation. That function carries
no address argument either, so its *reach* is bounded exactly as `mint`'s is.
`internal/research/00-DECISIONS.md` §1.4 nonetheless classifies it
`GUARD_REQUIRED`, and for a different reason: withdrawing collateral lowers an
account's borrowing power and can drive a borrowing account's health factor
below one, into self-liquidation. No `(target, selector, spend cap)` triple can
express a health-factor floor — a spend cap counts tokens leaving the account,
and a health factor is a function of the whole account's collateral and debt
together.

So when the only way to close a gap would be to withdraw from the over-weight
side, this agent holds, and its rationale names `redeemUnderlying(uint256)` and
the guard it would need. Reporting a balanced portfolio it did not achieve, or
proposing a call it cannot be granted, would both be worse than saying which
half of the job it has.

## What makes it hold

In order, and every one of them fails closed:

1. Any market's `implementation()` has moved off the pin.
2. Any market could not be fully read. An unread position defaulted to zero
   reads as maximally under-weight, so it would not merely be ignored — it would
   be the market the agent chose.
3. A token's `decimals()` disagrees with the configured value. The oracle scale
   is `1e(36 - decimals)`, and every weight shares one denominator, so one wrong
   market makes every other market's weight wrong too.
4. An oracle price is implausible for its decimals.
5. Nothing supplied and nothing idle anywhere.
6. The most under-weight market is inside the band.
7. That market is unlisted, has mint paused, or is at its supply cap. vBUSD on
   chain 97 is listed, priced, `mintPaused == true` and `supplyCaps == 0`, and is
   in the configured universe so this filter is a tested path rather than an
   untested branch.
8. There is no idle balance of that market's underlying — the `redeemUnderlying`
   case above.
9. There is no allowance. `mint` pulls with `transferFrom`, and only the
   account's admin key can grant that approval.
10. The largest permitted top-up is below `minRebalanceUsdMantissa`.

There is no fall-through to the second-most-underweight market. The agent acts
on the gap its own published ranking names or not at all, so a refusal states
what blocked it instead of leaving a reader to reverse-engineer a substitution.

## The independent model that judges it

`reference/rebalancing` reaches its own verdict by its own route and shares no
financial code with this package. The agent values a position through
`vTokenBalance -> underlying -> USD`, flooring at the intermediate, and reads a
market's supplied total as `totalSupply * exchangeRateStored`; the model
multiplies through and divides once, and reads the supplied total off the
balance sheet as `cash + totalBorrows - totalReserves`, publishing the
disagreement between the two routes as `identityDriftBps`.

The one thing the two must agree on exactly is the decision, so both write the
drift trigger out as a cross-multiplied integer comparison with no division:

```
targetWeightBps * portfolio - position * 10000  >=  triggerBps * portfolio
```

Each side carries its own copy. A shared predicate is precisely what would let
one arithmetic slip make the agent wrong and the evaluator agree with it.

The shared dependency set between the two packages is exactly
`["@mandate/domain", "viem"]`, and `reference/rebalancing/test/independence.test.ts`
asserts it.

## Running it

```bash
pnpm --filter @mandate/agent-rebalancing-a start
```

See `agents/reference/README.md` for the shared runtime contract, environment
variables and the deployment convention.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

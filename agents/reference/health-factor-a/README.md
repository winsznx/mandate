# Conservative Guardian (`health-factor-a`)

**Status: implemented.** This is the agent behind MANDATE's first authority
proof.

Defends a Venus Core-pool borrow position on BSC testnet 97. When the
liquidation-threshold-weighted health factor falls below **1.30**, it proposes a
`repayBorrow(uint256)` sized to restore it to **1.35**.

It proposes. It does not sign, submit, or hold a key. See
`agents/reference/README.md` for the runtime contract and the deployment
convention.

- Category: `HEALTH_FACTOR`
- Skill: `restore-health-factor`
- Target: Venus vUSDT `0xb7526572ffe56ab9d7489838bf2e18e3323b441a`
- Action: `repayBorrow(uint256)` / `0x0e752702`

## Why this action

`repayBorrow` takes an amount and nothing else. There is no recipient, no asset
and no path in calldata, so `(target, selector)` is a complete description of
what it can reach — which is precisely what an Altana session permission can
constrain. Its sibling `repayBorrowBehalf(address,uint256)` takes an arbitrary
beneficiary and is not boundable the same way, so it is never proposed and
never granted.

Repaying also only ever reduces the user's liability. The worst case with a
fully compromised session key is that the agent retires debt the user did not
choose to retire at that moment.

## The health factor

From `Comptroller.getAccountLiquidity(address)` (`0x5ec88c79`), which is
**liquidation-threshold weighted**. `getBorrowingPower` (`0x528a174c`) is
collateral-factor weighted and is a different number on the same account at the
same block — on testnet vUSDC the two weights are 0.75 and 0.80. Only the first
belongs in a health guard.

`getAccountLiquidity` returns a difference, not a ratio, so the borrow total is
needed too:

```
liquidity > 0  ->  HF = (borrowUsd + liquidity) / borrowUsd
shortfall > 0  ->  HF = (borrowUsd - shortfall) / borrowUsd
```

All fixed point at 1e18 in `bigint`. The repay amount becomes the argument of an
on-chain call, so floating-point drift would be a real discrepancy between the
proof page and the chain.

### `markets()` returns seven fields

```
(bool isListed, uint256 collateralFactorMantissa, bool isVenus,
 uint256 liquidationThresholdMantissa, uint256 liquidationIncentiveMantissa,
 uint96 poolId, bool isBorrowAllowed)
```

The legacy Compound V2 decode of `(bool, uint256, bool)` still succeeds against
this contract and silently drops the liquidation threshold, leaving the
collateral factor in its place. Those differ on the markets this agent touches,
so the wrong decode is a real error.

The 7-field decode feeds an independent reconstruction of weighted collateral,
which is compared against `getAccountLiquidity`. Drift beyond 200 bps is a
`HOLD`: a guardian that acts on a number it cannot reproduce is worse than one
that does nothing, because the action is irreversible and the inaction is not.

### VAI debt

Venus's own stablecoin is charged on the borrow side of the same solvency
calculation, but VAI is not a market and never appears in `getAssetsIn`. The
agent reads `VAIController.getVAIRepayAmount(account)` — principal **plus
accrued interest**, not `mintedVAIs` — and prices it through the same oracle.

Omitting the term does not merely lose it. Because the collateral figure is
derived by adding the reported liquidity back onto the borrow total, dropping
VAI silently reattributes that debt to collateral. Verified on a live chain-97
account: 2.0 VAI principal, 3.343647904264645996 actually owed, and the
reconstruction drift goes from 0 to **6,642 bps** when the term is dropped.
Both figures are pinned in `test/health.test.ts`.

## The decimal trap

The testnet mock USDT is **6 decimals**; BSC mainnet USDT is **18**. Venus
scales `getUnderlyingPrice` by `1e(36 - underlyingDecimals)`, so the decimals
live inside the price and a wrong value is not slightly wrong — it is twelve
orders of magnitude out.

Decimals for the market this agent acts on come from `VENUS_BSC_TESTNET`
configuration rather than from an assumption; every other market in the account
is read from the chain. `assertPlausiblePrice` then rejects a price that cannot
be right for the decimals it was read with. The testnet oracle's `5e29` is $0.50
at 6 decimals and would be $500 billion at 18, so the guard catches it.

The testnet oracle prices USDT at **$0.50**, not $1.00. Nothing here assumes a
peg.

## Implementation pinning

`vUSDT` is a Compound `VBep20Delegator` with its implementation at plain storage
slot 18 — the EIP-1967 slots are empty. `vUSDT.admin()` is a governance timelock
that can replace it. The agent reads `implementation()` at proposal time and
holds if it is not the audited `0x73ff75092da265b87b25ffb943c47c90419a04a6`,
because the authority analysis the policy rests on is an analysis of that
bytecode.

## When it holds

- the vToken implementation is not the audited one
- the account has no Venus debt
- the collateral reconstruction disagrees with `getAccountLiquidity` past tolerance
- the health factor is at or above 1.30 — **the threshold itself is not an intervention**
- the account owes nothing in USDT, the only market this agent may act on
- the repay needed is below the $1 floor

## Live behaviour

Against chain 97 account `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`:

```json
{ "decision": "HOLD",
  "observations": {
    "healthFactor": "2.505467",
    "healthFactorWeighting": "LIQUIDATION_THRESHOLD",
    "vaiDebtUsdMantissa": "3343647904264645996",
    "reconstructionDriftBps": 0,
    "vTokenImplementation": "0x73ff75092da265b87b25ffb943c47c90419a04a6" } }
```

## Tests

```bash
pnpm --filter @mandate/agent-health-factor-a test
```

`test/health.test.ts` covers the arithmetic against fixed fixtures at the real
testnet scales; `test/strategy.test.ts` covers the decisions, including the
above-threshold, below-threshold, exactly-at-threshold, zero-debt and
6-versus-18-decimal cases.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

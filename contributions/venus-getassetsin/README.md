# Reconstructing Venus account risk from `getAssetsIn` can omit debt

**Status:** reproducible on BSC testnet and mainnet
**Affects:** integrators reconstructing account health off-chain — monitors, liquidation bots, risk dashboards, agent frameworks
**Does not affect:** the Venus protocol's own solvency accounting, which is correct

## The claim, stated precisely

This is not a bug in Venus. `Comptroller.getAccountLiquidity` charges VAI debt
correctly, and the protocol liquidates correctly.

The issue is that a natural integration pattern — enumerate `getAssetsIn`, sum
the borrows, derive health — silently omits VAI, because **VAI is not a market
and never appears in `getAssetsIn`**. An integrator following that pattern can
classify a leveraged account as having no debt at all.

## Reproduction

No archive node required. Both routes below read current state.

### Route A: an account that already holds VAI debt

```bash
CT=0x94d1820b2D1c7c7452A163983Dc888CEC546b77D   # Comptroller, chain 97
VAIC=0xf70C3C6b749BbAb89C081737334E74C9aFD4be16 # VAIController, chain 97
ACC=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

cast call $CT   "getAssetsIn(address)(address[])" $ACC --rpc-url $RPC
cast call $CT   "mintedVAIs(address)(uint256)"    $ACC --rpc-url $RPC
cast call $VAIC "getVAIRepayAmount(address)(uint256)" $ACC --rpc-url $RPC
cast call $CT   "getAccountLiquidity(address)(uint256,uint256,uint256)" $ACC --rpc-url $RPC
```

Observed (chain 97, block 125,598,995, and re-confirmed unchanged at head
125,828,357 — roughly 230,000 blocks later, so a maintainer can reproduce this
from a plain RPC today):

| call | result |
|---|---|
| `getAssetsIn` | `[0xD5C4C2e2facBEB59D0216D0595d63FcDc6F9A1a7]` — one vToken, no VAI |
| sum of borrows across those markets | `0` |
| `mintedVAIs` | `2000000000000000000` |
| `getVAIRepayAmount` | `3343647904264645996` |
| `getAccountLiquidity` | `(0, 5033751870707585163, 0)` |

An integrator enumerating `getAssetsIn` finds **zero debt** and reports health
factor **infinity**. The account's real health factor is **2.505467**.

### Route B: construct the position yourself

Any account can reproduce it from scratch on testnet: supply a vToken, enter the
market, then mint VAI. `getAssetsIn` will list the collateral market and nothing
about the VAI debt.

## Two distinct mistakes

1. **`getAssetsIn` is not the debt universe.** It returns markets the account
   *entered*. VAI is minted through the Comptroller and has no market, so it is
   absent by construction. Use `getAllMarkets` for the vToken universe and read
   VAI separately.

2. **`mintedVAIs` is principal only.** It understates the debt by accrued
   interest — 67% on the account above. The figure to use is
   `VAIController.getVAIRepayAmount`, which is **not callable on the Comptroller
   Diamond**; that reverts `Diamond: Function does not exist`.

## Impact

A health monitor built this way does not report a wrong number. It reports *no
debt*, so it never fires. The failure is silent and it is in the direction that
hides risk.

## Correct reconstruction

```
borrow value = sum(borrowBalanceStored over getAllMarkets)
             + VAIController.getVAIRepayAmount   priced at par

collateral   = sum(vTokenBalance x exchangeRate x price x liquidationThreshold)
               over entered markets
```

Two further details this surfaced:

- `markets(address)` returns **seven** fields. The legacy Compound V2 decode of
  `(bool, uint256, bool)` still succeeds and silently leaves the collateral
  factor where the liquidation threshold belongs. On testnet vUSDT those differ,
  0.75 against 0.80.
- `getAccountLiquidity` is liquidation-threshold weighted; `getBorrowingPower`
  is collateral-factor weighted. They are different numbers for the same account
  at the same block.

Reconstructing this way reproduces the Comptroller's own liquidity to **0 bps**.
Omitting VAI leaves the naive route reporting infinity.

## Suggested documentation change

State in the integration docs that `getAssetsIn` returns entered markets rather
than total exposure, that VAI debt must be read from `VAIController`, and that
`mintedVAIs` excludes accrued interest.

## Regression tests

`packages/venus-bsc/test/venus-accounting-001.test.ts` through `-004`, frozen
against the live state above with full provenance (chain, block, block hash).

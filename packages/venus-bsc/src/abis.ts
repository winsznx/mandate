/**
 * Venus ABI fragments, vendored rather than imported.
 *
 * Two of these are easy to get quietly wrong, and both are load-bearing:
 *
 *  - `markets(address)` returns SEVEN fields. The legacy Compound V2 decode of
 *    `(bool, uint256, bool)` still succeeds against this contract and silently
 *    drops `liquidationThresholdMantissa` — the weight that actually decides
 *    liquidation — leaving the collateral factor in its place. On testnet vUSDT
 *    those two happen to differ (0.75 against 0.80), so the wrong decode is a
 *    real error and not a cosmetic one.
 *  - `getAccountLiquidity` is liquidation-threshold weighted. `getBorrowingPower`
 *    is collateral-factor weighted. They are different numbers on the same
 *    account at the same block, and only the first belongs in a health guard.
 */
import type { Hex } from "viem";

export const COMPTROLLER_ABI = [
  {
    type: "function",
    name: "getAssetsIn",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    // The complete market universe. `getAssetsIn` returns only the subset the
    // account entered, which is not the same question and is why
    // VENUS-ACCOUNTING-001 exists.
    type: "function",
    name: "getAllMarkets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "mintedVAIs",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getAccountLiquidity",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "error", type: "uint256" },
      { name: "liquidity", type: "uint256" },
      { name: "shortfall", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ name: "vToken", type: "address" }],
    outputs: [
      { name: "isListed", type: "bool" },
      { name: "collateralFactorMantissa", type: "uint256" },
      { name: "isVenus", type: "bool" },
      { name: "liquidationThresholdMantissa", type: "uint256" },
      { name: "liquidationIncentiveMantissa", type: "uint256" },
      { name: "poolId", type: "uint96" },
      { name: "isBorrowAllowed", type: "bool" },
    ],
  },
  {
    // The ceiling on total supply for a market, in underlying units. A market
    // at its cap rejects `mint`, so a supply-side agent that ignores this
    // proposes a call that reverts.
    type: "function",
    name: "supplyCaps",
    stateMutability: "view",
    inputs: [{ name: "vToken", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // `action` indexes the Venus `Action` enum, where `MINT` is 0. Read rather
    // than assumed: testnet vBUSD is a listed market with mint paused, and a
    // reader that only checks `isListed` treats it as available.
    type: "function",
    name: "actionPaused",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "action", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** Index of `MINT` in the Venus Comptroller's `Action` enum. */
export const VENUS_ACTION_MINT = 0;

export const VTOKEN_ABI = [
  {
    type: "function",
    name: "getAccountSnapshot",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "error", type: "uint256" },
      { name: "vTokenBalance", type: "uint256" },
      { name: "borrowBalance", type: "uint256" },
      { name: "exchangeRateMantissa", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "borrowBalanceStored",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "underlying",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "implementation",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "repayBorrow",
    stateMutability: "nonpayable",
    inputs: [{ name: "repayAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // Interest per block, not per year. Venus's interest-rate model on chain 97
    // is itself behind a proxy that reverts on `blocksOrSecondsPerYear()`, so
    // there is no on-chain annualisation constant to read and any yearly figure
    // is a stated convention rather than a protocol fact.
    type: "function",
    name: "supplyRatePerBlock",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "exchangeRateStored",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // `getCash`, `totalBorrows` and `totalReserves` are the other side of the
    // exchange-rate identity: the underlying a market holds is
    // `cash + borrows - reserves`, and it is also `totalSupply * exchangeRate`.
    // Both are readable, and reading both is what lets two implementations
    // reach the same figure without sharing an arithmetic route.
    type: "function",
    name: "getCash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalBorrows",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ name: "mintAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * `getVAIRepayAmount` returns minted VAI plus its accrued interest.
 *
 * `mintedVAIs` alone is the principal and is not what the solvency calculation
 * charges. On a live testnet account the two differ by 67% — 2.0 principal
 * against 3.343647904264645996 owed — and using the principal would overstate
 * the health factor of every account carrying VAI.
 */
export const VAI_CONTROLLER_ABI = [
  {
    type: "function",
    name: "getVAIRepayAmount",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ORACLE_ABI = [
  {
    type: "function",
    name: "getUnderlyingPrice",
    stateMutability: "view",
    inputs: [{ name: "vToken", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // `mint` pulls the underlying with `transferFrom`, so an account with the
    // balance but not the allowance produces a call that reverts. The allowance
    // is granted by the admin key and never by the session, so an agent has to
    // read it rather than assume it.
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * `repayBorrow(uint256)`.
 *
 * The reason this is the first action MANDATE proves: it takes an amount and
 * nothing else. There is no recipient, no asset and no path in calldata, so
 * `(target, selector)` is a complete description of what it can reach — which
 * is exactly the shape an Altana session permission can constrain.
 */
export const REPAY_BORROW_SELECTOR: Hex = "0x0e752702";
export const REPAY_BORROW_SIGNATURE = "repayBorrow(uint256)" as const;

/**
 * `mint(uint256)`.
 *
 * The supply-side counterpart of `repayBorrow`, and boundable for the same
 * reason: one `uint256` and nothing else. The minted vTokens are credited to
 * `msg.sender` from protocol storage, and the underlying is pulled from
 * `msg.sender` by `transferFrom`, so neither side of the transfer is reachable
 * from calldata.
 *
 * Confirmed on a fork of chain 97 at block 125929412. From a funded account,
 * `vUSDT.mint(500000000)` succeeded with calldata that is exactly the selector
 * and the amount; the caller's vUSDT balance rose from 0 to 2490331760957 and a
 * second account's balance stayed at 0. `vUSDC.mint(400000000)` behaves the
 * same way.
 */
export const MINT_SELECTOR: Hex = "0xa0712d68";
export const MINT_SIGNATURE = "mint(uint256)" as const;

/**
 * `mintBehalf(address,uint256)`. Present on the same implementation, and never
 * grantable.
 *
 * The negative control for `mint`, exactly as `repayBorrowBehalf` is for
 * `repayBorrow`: the first argument is an arbitrary beneficiary, so a session
 * holding this selector can supply the user's funds and credit the resulting
 * vTokens to any address. Confirmed present in the runtime bytecode of the
 * pinned implementation `0x73ff75092da265b87b25ffb943c47c90419a04a6` on chain
 * 97, which is why an agent card that says "mint" has to say which one.
 */
export const MINT_BEHALF_SELECTOR: Hex = "0x23323e03";
export const MINT_BEHALF_SIGNATURE = "mintBehalf(address,uint256)" as const;

/**
 * `redeemUnderlying(uint256)`. Boundable in reach, not in consequence.
 *
 * It carries no address argument, so `(target, selector)` does describe
 * everything it can touch. It is nonetheless classified `GUARD_REQUIRED` in
 * `internal/research/00-DECISIONS.md` §1.4 for a different reason: withdrawing
 * collateral can drive a borrowing account's health factor below one, and no
 * `(target, selector, spend cap)` triple can express a health-factor floor.
 *
 * The distinction matters to the supply-side categories, so it is stated here
 * rather than left to be rediscovered: the constraint is a risk invariant, not
 * calldata reachability, and the two are not the same kind of unboundedness.
 */
export const REDEEM_UNDERLYING_SELECTOR: Hex = "0x852a12e3";
export const REDEEM_UNDERLYING_SIGNATURE = "redeemUnderlying(uint256)" as const;

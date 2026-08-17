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
] as const;

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

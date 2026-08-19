/**
 * Venus ABI fragments, vendored rather than imported.
 *
 * The same choice `yield-a` and `health-factor-a` make, for the same reason.
 * This agent and the reference model that judges it must not share the code
 * that turns chain readings into an answer, and the cheapest way to guarantee
 * that is for neither to be able to resolve the other's modules at all. The
 * overlap between the two packages is `@mandate/domain` and `viem`, and
 * `reference/rebalancing/test/independence.test.ts` asserts it.
 *
 * There is no `supplyRatePerBlock` here, unlike in `yield-a`. This agent does
 * not rank markets by what they pay; it holds a published set of weights, and
 * a rate it never reads is a rate it cannot accidentally reason from.
 *
 * Three of these are easy to leave out and expensive to leave out:
 *
 *  - `actionPaused(address,uint8)` with `MINT == 0`. Testnet vBUSD is listed,
 *    is priced by the oracle, and rejects every `mint`. An agent that filters
 *    on `isListed` alone proposes a call that reverts.
 *  - `supplyCaps(address)` reads zero on retired markets. Zero means "accepts
 *    nothing", not "no ceiling", and reading it the other way inverts the
 *    filter on exactly the markets it exists to exclude.
 *  - `allowance` on the underlying. `mint` pulls funds with `transferFrom`, and
 *    the approval is signed by the account's admin key rather than by the
 *    session, so it is a precondition the agent has to check rather than one it
 *    can create.
 */
import type { Hex } from "viem";

export const COMPTROLLER_ABI = [
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
    type: "function",
    name: "actionPaused",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "action", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "supplyCaps",
    stateMutability: "view",
    inputs: [{ name: "vToken", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Index of `MINT` in the Venus Comptroller's `Action` enum. */
export const ACTION_MINT = 0;

export const VTOKEN_ABI = [
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
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
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
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ name: "mintAmount", type: "uint256" }],
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

export const ORACLE_ABI = [
  {
    type: "function",
    name: "getUnderlyingPrice",
    stateMutability: "view",
    inputs: [{ name: "vToken", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * `mint(uint256)`. The only action this agent ever proposes.
 *
 * Grantable under `(target, selector, spend cap)` with no guard, and the
 * grounds are structural rather than a judgement call: the function takes one
 * `uint256` and nothing else, the vTokens are credited to `msg.sender` from
 * protocol storage, and the underlying is pulled from `msg.sender` by
 * `transferFrom`. Neither leg of the transfer is reachable from calldata, so
 * `(target, selector)` is a complete description of what the call can touch.
 *
 * Verified present in the pinned implementation
 * `0x73ff75092da265b87b25ffb943c47c90419a04a6` on chain 97, whose runtime
 * bytecode is 24,250 bytes and byte-identical in codehash to the mainnet
 * `VBep20Delegate`. Verified on a fork of chain 97 at block 125929412:
 * `vUSDT.mint(500000000)` from a funded account returned status 1, moved the
 * caller's USDT from 1000000000 to 500000000, raised the caller's vUSDT balance
 * from 0 to 2490331760957, and left an uninvolved second account's vUSDT
 * balance at 0.
 */
export const MINT_SELECTOR: Hex = "0xa0712d68";
export const MINT_SIGNATURE = "mint(uint256)" as const;

/**
 * `redeemUnderlying(uint256)`. Named in this agent's refusals, never granted.
 *
 * This is the half of a rebalance the agent does not have. Closing a gap by
 * reducing the over-weight side needs this function, and it is present in the
 * same pinned implementation, so its absence from the permission set is a
 * choice rather than a protocol limitation.
 *
 * It is worth being exact about why it is withheld, because the obvious reason
 * is the wrong one. `redeemUnderlying` carries no address argument: the
 * underlying goes to `msg.sender` and the vTokens are burned from
 * `msg.sender`, so its *reach* is bounded by `(target, selector)` exactly as
 * `mint`'s is. What is unbounded is its effect on a risk invariant.
 * Withdrawing collateral lowers the account's borrowing power, and on an
 * account carrying debt it can drive the health factor below one and open the
 * position to liquidation. `00-DECISIONS.md` §1.4 classifies it
 * `GUARD_REQUIRED` on exactly those grounds. No `(target, selector, spend cap)`
 * triple can express "and leave the health factor above 1.0", because a spend
 * cap counts tokens and a health factor is a function of the whole account.
 *
 * So this agent rebalances by top-up only, and says so when that is what stops
 * it rather than reporting a balanced portfolio it did not achieve.
 */
export const REDEEM_UNDERLYING_SELECTOR: Hex = "0x852a12e3";
export const REDEEM_UNDERLYING_SIGNATURE = "redeemUnderlying(uint256)" as const;

/**
 * `mintBehalf(address,uint256)`. On the same implementation, and never granted.
 *
 * Stated here because an agent card that advertises "mint" has to say which
 * one. This variant takes an arbitrary beneficiary, so a session holding it
 * could supply the user's funds and credit the vTokens elsewhere. It is present
 * in the runtime bytecode of the pinned implementation, so its absence from
 * this agent's proposals is a property of the agent rather than of the
 * protocol, and the permission set is what makes it unreachable.
 */
export const MINT_BEHALF_SELECTOR: Hex = "0x23323e03";

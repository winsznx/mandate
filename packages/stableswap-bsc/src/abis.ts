/**
 * Stableswap-NG ABI fragments, vendored rather than imported.
 *
 * The pool is Vyper-compiled, so there is no Solidity interface to import and
 * every fragment here was checked against the deployed contract rather than
 * against a docs page. Three of them are easy to get quietly wrong:
 *
 *  - `stored_rates()` is not decoration. This pool holds two liquid-staking
 *    tokens whose redemption values drift apart, and the invariant is computed
 *    on RATE-ADJUSTED balances. Reading `balances()` alone and treating the pool
 *    as balanced at 1:1 misprices it by the whole rate spread, which on chain 97
 *    is currently 16%.
 *  - `A()` returns the amplification already divided by `A_PRECISION`. The
 *    invariant needs the raw value, so a reconstruction has to multiply it back
 *    by 100. Using the returned figure directly solves a different curve.
 *  - `is_killed()` exists on older Curve pools and NOT on stableswap-ng. It
 *    reverts here. Anything that treats a revert as "killed" refuses to trade a
 *    perfectly live pool; anything that treats it as "not killed" is guessing.
 *    It is absent from this ABI so neither can happen by accident.
 */
import type { Hex } from "viem";

export const STABLESWAP_POOL_ABI = [
  {
    type: "function",
    name: "coins",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "balances",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // Already divided by A_PRECISION. The invariant needs `A() * 100`.
    type: "function",
    name: "A",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    /** Base fee out of `FEE_DENOMINATOR = 1e10`, before the off-peg multiplier. */
    type: "function",
    name: "fee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    /**
     * Scales the fee up as the pool moves away from balance.
     *
     * At or below `FEE_DENOMINATOR` it is inert. Above it the realised fee on a
     * trade is strictly larger than `fee()`, so a reconstruction that ignores
     * it over-quotes the output of every swap it prices.
     */
    type: "function",
    name: "offpeg_fee_multiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    /** Per-coin rate multipliers at 1e18. The invariant runs on `balance * rate / 1e18`. */
    type: "function",
    name: "stored_rates",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "get_virtual_price",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    /**
     * The pool's own quote for a swap.
     *
     * Recorded, and never the basis of an independent verdict. It is the
     * quantity the reference model reconstructs from the invariant precisely so
     * that agreeing with it means something.
     */
    type: "function",
    name: "get_dy",
    stateMutability: "view",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "dx", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "exchange",
    stateMutability: "nonpayable",
    inputs: [
      { name: "i", type: "int128" },
      { name: "j", type: "int128" },
      { name: "_dx", type: "uint256" },
      { name: "_min_dy", type: "uint256" },
    ],
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
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
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

/**
 * `exchange(int128,int128,uint256,uint256)`.
 *
 * The one swap entry point found on BSC testnet 97 that a `(target, selector)`
 * permission can describe completely. The calldata is 132 bytes: the selector
 * and four integer words — two coin indices, an input amount and a minimum
 * output. There is no address field anywhere in it, the coin pair is pinned by
 * the pool address the permission names, and the output is credited to
 * `msg.sender` by the pool's own code.
 *
 * Verified by execution on a fork of chain 97 at block 125932679 against pool
 * `0x157b06e4d9501071a401234f117edee913217833`: `exchange(0, 1, 1e18, 0)` from a
 * funded account returned status 1, credited the caller 1158019126116580062
 * mstETH, and left an uninvolved third address at zero.
 *
 * This contradicts `internal/research/00-DECISIONS.md` §3.2, which says every
 * PancakeSwap entry point puts a recipient in calldata. That remains true of
 * every V2 and V3 router path — all seventeen state-changing entries in the V2
 * router's dispatch table take an `address to` — and it is not true of the
 * Curve-derived stableswap surface, which the report did not cover.
 */
export const EXCHANGE_SELECTOR: Hex = "0x3df02124";
export const EXCHANGE_SIGNATURE = "exchange(int128,int128,uint256,uint256)" as const;

/**
 * `exchange(int128,int128,uint256,uint256,address)`. The same trade, and never grantable.
 *
 * The negative control, and the sharpest one in this repository because both
 * variants live on the same contract and do the same thing. The fifth argument
 * is an arbitrary receiver. Executed on the same fork, in the same session,
 * from the same account: the four-argument form credited the caller and the
 * five-argument form credited `0x00000000000000000000000000000000deadbeef`
 * with 1158019126116580062 mstETH.
 *
 * One calldata word is the entire distance between an action MANDATE can bound
 * and one it cannot, and the agent card has to name the signature rather than
 * the verb for exactly that reason.
 */
export const EXCHANGE_RECEIVER_SELECTOR: Hex = "0xddc1f59d";
export const EXCHANGE_RECEIVER_SIGNATURE =
  "exchange(int128,int128,uint256,uint256,address)" as const;

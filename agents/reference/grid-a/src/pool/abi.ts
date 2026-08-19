/**
 * Stableswap-NG ABI fragments, vendored rather than imported.
 *
 * The same choice `health-factor-a` and `yield-a` make, for the same reason.
 * This agent and the reference model that judges it must not share the code
 * that turns chain readings into a price, and the cheapest way to guarantee
 * that is for neither to be able to resolve the other's modules at all. The
 * overlap between the two packages is `@mandate/domain` and `viem`, and the
 * independence suite asserts it.
 *
 * This agent asks the pool. `get_dy` is the pool's own answer to "what does
 * this swap return", and taking it is a defensible thing for an agent to do:
 * it is the number the trade will actually execute at, from the contract that
 * will execute it. The reference model refuses to ask and solves the invariant
 * instead, so a bug in either route shows up as a disagreement rather than as a
 * receipt.
 *
 * `is_killed()` is deliberately absent. It exists on older Curve pools and not
 * on stableswap-ng, where it reverts. An agent carrying the fragment would have
 * to decide what a revert means, and both readings are wrong: treating it as
 * "killed" refuses to trade a live pool, treating it as "not killed" is a guess.
 */
import type { Hex } from "viem";

export const POOL_ABI = [
  {
    type: "function",
    name: "balances",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    /** Per-coin rate multipliers at 1e18. Both coins here are LSTs and these diverge. */
    type: "function",
    name: "stored_rates",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
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
    name: "get_virtual_price",
    stateMutability: "view",
    inputs: [],
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
 * The reason a grid can be granted at all. The calldata is 132 bytes — the
 * selector and four integer words — and contains no address field. The coin
 * pair is pinned by the pool address the permission names, and the pool credits
 * the output to `msg.sender` from its own code, so `(target, selector)` is a
 * complete description of what the call can reach.
 *
 * Verified by execution on a fork of chain 97 at block 125932679 against
 * `0x157b06e4d9501071a401234f117edee913217833`: `exchange(0, 1, 1e18, 0)`
 * returned status 1, credited the caller 1158019126116580062 mstETH, and left
 * an uninvolved third address at zero.
 *
 * It is not risk-free, and the difference matters. `min_dy` is
 * calldata-controlled, so a session that proposed zero would be inside its
 * mandate and would still hand the account to the first searcher who noticed.
 * That is a value-loss channel bounded by the standing allowance and the spend
 * window rather than an exfiltration channel, which puts this action between
 * Venus `repayBorrow`, which can only reduce a liability, and anything that
 * takes a recipient. The agent's own slippage bound is the whole of the
 * mitigation, which is why the policy publishes it and the evaluator compares it.
 */
export const EXCHANGE_SELECTOR: Hex = "0x3df02124";
export const EXCHANGE_SIGNATURE = "exchange(int128,int128,uint256,uint256)" as const;

/**
 * `exchange(int128,int128,uint256,uint256,address)`. Same contract, never granted.
 *
 * The negative control, and the sharpest one in this repository because both
 * variants live on the same pool and do the same trade. The fifth argument is
 * an arbitrary receiver. Executed on the same fork in the same session from the
 * same account: the four-argument form credited the caller and the
 * five-argument form credited `0x00000000000000000000000000000000deadbeef`.
 *
 * One calldata word is the entire distance between an action MANDATE can bound
 * and one it cannot, which is why this agent's card names the signature and not
 * the verb.
 */
export const EXCHANGE_RECEIVER_SELECTOR: Hex = "0xddc1f59d";

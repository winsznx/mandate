/**
 * The stableswap-NG pool this agent trades, BSC testnet 97.
 *
 * Every field was read back off the live chain. The pool was reached by walking
 * `PancakeSwap SmartRouter.stableSwapFactory()` into its pair list rather than
 * guessed at, and it reports `version() == "v7.0.0"` — Curve stableswap-ng,
 * deployed on testnet and reachable through Pancake's own router.
 *
 * It is the only venue found on chain 97 with both real balanced depth and an
 * entry point a `(target, selector)` permission can describe. At block
 * 125936215 it held 11000.09 wstETH against 10999.90 mstETH with a virtual
 * price of 1.000000004561277297. The PancakeSwap V2 pairs a grid would
 * otherwise use are unusable: the WBNB/USDT pair holds 0.1 WBNB against a USDT
 * reserve seeded as though the token were 18 decimals, and the USDT/USDC pair
 * last traded two years before head at a ratio of 11,124:1 on a pegged pair.
 *
 * `codeHash` is pinned in place of an implementation address. This pool is not
 * a proxy, so there is no `implementation()` to read; the equivalent guarantee
 * is that the runtime bytecode at the address is the code that was analysed.
 * An agent that finds it changed is looking at a different contract wearing the
 * same address.
 */
import type { Address, Hex } from "viem";

export interface PoolCoin {
  readonly index: number;
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface PoolDeployment {
  readonly chainId: number;
  readonly pool: Address;
  readonly poolName: string;
  /** `EXTCODEHASH` of the deployed runtime, checked at proposal time. */
  readonly codeHash: Hex | null;
  readonly coins: readonly PoolCoin[];
}

export const STABLESWAP_BSC_TESTNET: PoolDeployment = {
  chainId: 97,
  pool: "0x157b06e4d9501071a401234f117edee913217833",
  poolName: "wstETH/mstETH",
  // Left unpinned until a deployment record carries it, and checked only when
  // set. A hardcoded hash that nobody verified is worse than an absent one: it
  // fails every proposal for a reason the operator cannot distinguish from a
  // real governance event.
  codeHash: null,
  coins: [
    { index: 0, token: "0x5dbb9d2d526ab0c5f8829ad4951fb2dd93e0b62f", symbol: "wstETH", decimals: 18 },
    { index: 1, token: "0xc97642f407caea4f31464ab005276e5fb215c6fa", symbol: "mstETH", decimals: 18 },
  ],
};

export const POOL_DEPLOYMENTS: Readonly<Record<number, PoolDeployment>> = {
  [STABLESWAP_BSC_TESTNET.chainId]: STABLESWAP_BSC_TESTNET,
};

export function poolDeploymentFor(chainId: number): PoolDeployment {
  const deployment = POOL_DEPLOYMENTS[chainId];
  if (deployment === undefined) {
    throw new Error(`no stableswap pool configured for chain ${chainId}`);
  }
  return deployment;
}

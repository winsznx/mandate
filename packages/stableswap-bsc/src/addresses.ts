/**
 * Stableswap-NG deployment, BSC testnet 97.
 *
 * Every field was read back off the live chain. The pool was not guessed at: it
 * was reached by walking `PancakeSwap SmartRouter.stableSwapFactory()` into its
 * pair list, which turned up three Vyper contracts reporting
 * `version() == "v7.0.0"` — Curve stableswap-ng, deployed on testnet and
 * reachable through Pancake's own router.
 *
 * `0x157b06e4…` is the only pool found on chain 97 with both real balanced
 * depth and a boundable entry point. At block 125936215 it held 11000.09 wstETH
 * against 10999.90 mstETH with a virtual price of 1.000000004561277297. The two
 * PancakeSwap V2 pairs a grid would otherwise use are unusable: the WBNB/USDT
 * pair holds 0.1 WBNB against a USDT reserve seeded as though the token were
 * 18 decimals, and the USDT/USDC pair last traded two years before head at a
 * ratio of 11,124:1 on a pegged pair.
 *
 * `poolImplementation` is pinned for the same reason the Venus vToken
 * implementation is: a proxy whose code can move makes "bounded by target plus
 * selector" only as strong as whoever can move it. This pool is not a proxy —
 * `EXTCODEHASH` is the code itself — so the pin is a hash of the deployed
 * runtime rather than an implementation address, and an agent that finds it
 * changed is looking at a different contract at the same address.
 */
import type { Address } from "viem";

export interface StableswapCoin {
  readonly index: number;
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface StableswapDeployment {
  readonly chainId: number;
  readonly pool: Address;
  readonly poolName: string;
  /** Curve's `A_PRECISION`. `A()` returns the amplification already divided by it. */
  readonly amplificationPrecision: bigint;
  /** Curve's `FEE_DENOMINATOR`. Fees and the off-peg multiplier are quoted out of this. */
  readonly feeDenominator: bigint;
  readonly coins: readonly StableswapCoin[];
}

export const STABLESWAP_BSC_TESTNET: StableswapDeployment = {
  chainId: 97,
  pool: "0x157b06e4d9501071a401234f117edee913217833",
  poolName: "wstETH/mstETH",
  amplificationPrecision: 100n,
  feeDenominator: 10n ** 10n,
  coins: [
    {
      index: 0,
      token: "0x5dbb9d2d526ab0c5f8829ad4951fb2dd93e0b62f",
      symbol: "wstETH",
      decimals: 18,
    },
    {
      index: 1,
      token: "0xc97642f407caea4f31464ab005276e5fb215c6fa",
      symbol: "mstETH",
      decimals: 18,
    },
  ],
};

export const STABLESWAP_DEPLOYMENTS: Readonly<Record<number, StableswapDeployment>> = {
  [STABLESWAP_BSC_TESTNET.chainId]: STABLESWAP_BSC_TESTNET,
};

export function stableswapDeploymentFor(chainId: number): StableswapDeployment {
  const deployment = STABLESWAP_DEPLOYMENTS[chainId];
  if (deployment === undefined) {
    throw new Error(`no stableswap deployment configured for chain ${chainId}`);
  }
  return deployment;
}

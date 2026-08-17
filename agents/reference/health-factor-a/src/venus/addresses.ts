/**
 * Venus Core-pool deployment, BSC testnet 97.
 *
 * Every address here was read back off the live chain rather than copied from
 * a docs page, and the vUSDT implementation is pinned deliberately. Venus
 * `vUSDT.admin()` is a governance timelock that can swap the implementation
 * behind the proxy, so "bounded by target plus selector" is only as strong as
 * that timelock unless the implementation is checked at proposal time. The
 * agent reads it and refuses to act when it has moved.
 *
 * `underlyingDecimals` is configured per chain rather than assumed. The testnet
 * mock USDT is 6 decimals and BSC mainnet USDT is 18, and the oracle price
 * scale is `1e(36 - decimals)`, so a wrong decimals value does not produce a
 * slightly wrong number — it produces one twelve orders of magnitude out.
 */
import type { Address } from "viem";

export interface VenusDeployment {
  readonly chainId: number;
  readonly comptroller: Address;
  readonly vToken: Address;
  /** Expected `implementation()` behind the `VBep20Delegator` proxy. */
  readonly vTokenImplementation: Address;
  readonly underlying: Address;
  readonly underlyingSymbol: string;
  readonly underlyingDecimals: number;
  readonly oracle: Address;
  /**
   * VAI is Venus's own stablecoin and its debt is part of the same solvency
   * calculation as the vToken markets, but it is not a market and does not
   * appear in `getAssetsIn`. Reading it takes a separate contract, so the
   * address is configuration rather than something derivable from the others.
   */
  readonly vaiController: Address;
  readonly vai: Address;
}

export const VENUS_BSC_TESTNET: VenusDeployment = {
  chainId: 97,
  comptroller: "0x94d1820b2d1c7c7452a163983dc888cec546b77d",
  vToken: "0xb7526572ffe56ab9d7489838bf2e18e3323b441a",
  vTokenImplementation: "0x73ff75092da265b87b25ffb943c47c90419a04a6",
  underlying: "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c",
  underlyingSymbol: "USDT",
  underlyingDecimals: 6,
  oracle: "0x3cd69251d04a28d887ac14cbe2e14c52f3d57823",
  vaiController: "0xf70c3c6b749bbab89c081737334e74c9afd4be16",
  vai: "0x5ffbe5302baded40941a403228e6ad03f93752d9",
};

export const VENUS_DEPLOYMENTS: Readonly<Record<number, VenusDeployment>> = {
  [VENUS_BSC_TESTNET.chainId]: VENUS_BSC_TESTNET,
};

export function venusDeploymentFor(chainId: number): VenusDeployment {
  const deployment = VENUS_DEPLOYMENTS[chainId];
  if (deployment === undefined) {
    throw new Error(`no Venus deployment configured for chain ${chainId}`);
  }
  return deployment;
}

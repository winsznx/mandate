/**
 * The Venus Core-pool supply markets this agent may be pointed at, BSC testnet 97.
 *
 * Every address was read back off the live chain. All three markets share one
 * `implementation()` at `0x73ff75092da265b87b25ffb943c47c90419a04a6`, which is
 * pinned here for the same reason `health-factor-a` pins it: `vToken.admin()`
 * is a governance timelock that can replace the code behind the proxy, so
 * "bounded by target plus selector" is only as strong as that timelock unless
 * the implementation is checked at proposal time. This agent reads it on every
 * market it considers and refuses to act on one that has moved.
 *
 * `underlyingDecimals` is configuration rather than a runtime read. The oracle
 * quotes `getUnderlyingPrice` at `1e(36 - decimals)`, the testnet mocks are 6 dp
 * where mainnet USDT is 18, and a wrong value is not a rounding error — it
 * misprices the market by twelve orders of magnitude and sizes a deployment to
 * match. The agent reads `decimals()` as well and holds when the two disagree.
 *
 * vBUSD is in the configured universe deliberately. It is a listed, priced,
 * retired market with `mintPaused == true` and a supply cap of zero, so it is
 * the market that proves the availability filter does something.
 */
import type { Address } from "viem";

export interface SupplyMarket {
  readonly vToken: Address;
  readonly underlying: Address;
  readonly symbol: string;
  readonly underlyingDecimals: number;
}

export interface VenusSupplyDeployment {
  readonly chainId: number;
  readonly comptroller: Address;
  readonly oracle: Address;
  /** Expected `implementation()` behind every `VBep20Delegator` in `markets`. */
  readonly vTokenImplementation: Address;
  readonly markets: readonly SupplyMarket[];
}

export const VENUS_SUPPLY_BSC_TESTNET: VenusSupplyDeployment = {
  chainId: 97,
  comptroller: "0x94d1820b2d1c7c7452a163983dc888cec546b77d",
  oracle: "0x3cd69251d04a28d887ac14cbe2e14c52f3d57823",
  vTokenImplementation: "0x73ff75092da265b87b25ffb943c47c90419a04a6",
  markets: [
    {
      vToken: "0xb7526572ffe56ab9d7489838bf2e18e3323b441a",
      underlying: "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c",
      symbol: "USDT",
      underlyingDecimals: 6,
    },
    {
      vToken: "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7",
      underlying: "0x16227d60f7a0e586c66b005219dfc887d13c9531",
      symbol: "USDC",
      underlyingDecimals: 6,
    },
    {
      vToken: "0x08e0a5575de71037ae36abfafb516595fe68e5e4",
      underlying: "0x8301f2213c0eed49a7e28ae4c3e91722919b8b47",
      symbol: "BUSD",
      underlyingDecimals: 18,
    },
  ],
};

export const VENUS_SUPPLY_DEPLOYMENTS: Readonly<Record<number, VenusSupplyDeployment>> = {
  [VENUS_SUPPLY_BSC_TESTNET.chainId]: VENUS_SUPPLY_BSC_TESTNET,
};

export function venusSupplyDeploymentFor(chainId: number): VenusSupplyDeployment {
  const deployment = VENUS_SUPPLY_DEPLOYMENTS[chainId];
  if (deployment === undefined) {
    throw new Error(`no Venus supply deployment configured for chain ${chainId}`);
  }
  return deployment;
}

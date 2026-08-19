/**
 * The Venus Core-pool markets this agent allocates across, BSC testnet 97.
 *
 * Every address was read back off the live chain. All three markets share one
 * `implementation()` at `0x73ff75092da265b87b25ffb943c47c90419a04a6`, which is
 * pinned here because `vToken.admin()` is a governance timelock that can
 * replace the code behind the proxy. "Bounded by target plus selector" is only
 * as strong as that timelock unless the implementation is checked at proposal
 * time, so this agent reads it on every market it considers and refuses to act
 * on one that has moved.
 *
 * `underlyingDecimals` is configuration rather than a runtime read. The oracle
 * quotes `getUnderlyingPrice` at `1e(36 - decimals)`, the testnet mocks are 6 dp
 * where mainnet USDT is 18, and a wrong value is not a rounding error — it
 * misprices the market by twelve orders of magnitude and would drive an
 * allocation entirely from the mispricing. The agent reads `decimals()` as well
 * and holds when the two disagree.
 *
 * vBUSD is in the configured universe deliberately, and it does two jobs here
 * that it does not do in the yield category. It is the market that proves the
 * availability filter does something — listed, priced, `mintPaused == true`,
 * supply cap zero. And BUSD sitting idle in the wallet is capital the published
 * allocation has to account for even though no target weight names it, which is
 * what makes the portfolio denominator a decision rather than a detail.
 */
import type { Address } from "viem";

export interface AllocationMarket {
  readonly vToken: Address;
  readonly underlying: Address;
  readonly symbol: string;
  readonly underlyingDecimals: number;
}

export interface VenusAllocationDeployment {
  readonly chainId: number;
  readonly comptroller: Address;
  readonly oracle: Address;
  /** Expected `implementation()` behind every `VBep20Delegator` in `markets`. */
  readonly vTokenImplementation: Address;
  readonly markets: readonly AllocationMarket[];
}

/**
 * The market addresses, named so a target weight can cite one.
 *
 * A published allocation names markets, so the policy has to reference these
 * addresses directly. Exported here rather than restated there, because two
 * copies of an address is one copy too many: a weight pointing at a market that
 * is not in the configured universe would produce a portfolio that silently
 * never reaches its target.
 */
export const VUSDT_BSC_TESTNET = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as Address;
export const VUSDC_BSC_TESTNET = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7" as Address;
export const VBUSD_BSC_TESTNET = "0x08e0a5575de71037ae36abfafb516595fe68e5e4" as Address;

export const VENUS_ALLOCATION_BSC_TESTNET: VenusAllocationDeployment = {
  chainId: 97,
  comptroller: "0x94d1820b2d1c7c7452a163983dc888cec546b77d",
  oracle: "0x3cd69251d04a28d887ac14cbe2e14c52f3d57823",
  vTokenImplementation: "0x73ff75092da265b87b25ffb943c47c90419a04a6",
  markets: [
    {
      vToken: VUSDT_BSC_TESTNET,
      underlying: "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c",
      symbol: "USDT",
      underlyingDecimals: 6,
    },
    {
      vToken: VUSDC_BSC_TESTNET,
      underlying: "0x16227d60f7a0e586c66b005219dfc887d13c9531",
      symbol: "USDC",
      underlyingDecimals: 6,
    },
    {
      vToken: VBUSD_BSC_TESTNET,
      underlying: "0x8301f2213c0eed49a7e28ae4c3e91722919b8b47",
      symbol: "BUSD",
      underlyingDecimals: 18,
    },
  ],
};

export const VENUS_ALLOCATION_DEPLOYMENTS: Readonly<Record<number, VenusAllocationDeployment>> = {
  [VENUS_ALLOCATION_BSC_TESTNET.chainId]: VENUS_ALLOCATION_BSC_TESTNET,
};

export function venusAllocationDeploymentFor(chainId: number): VenusAllocationDeployment {
  const deployment = VENUS_ALLOCATION_DEPLOYMENTS[chainId];
  if (deployment === undefined) {
    throw new Error(`no Venus allocation deployment configured for chain ${chainId}`);
  }
  return deployment;
}

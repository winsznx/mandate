/**
 * Contracts old enough and boring enough to probe with.
 *
 * A probe target has exactly two requirements: it existed at every depth the
 * search will reach, and reading it touches state rather than returning a
 * constant. Both matter. A contract deployed after the deepest probe block
 * returns `0x` from a perfectly healthy archive node, which reads as a pruned
 * window and produces a measurement of nothing.
 *
 * These are the same tokens the decisions table already pins, so a wrong
 * address here contradicts a `V-CHAIN` fact rather than sitting undetected.
 */

export const BSC_MAINNET = 56;
export const BSC_TESTNET = 97;

/** BSC-USD, deployed 2020. Eighteen decimals on mainnet, which is its own trap elsewhere. */
export const BSC_MAINNET_PROBE_CONTRACT = "0x55d398326f99059fF775485246999027B3197955" as const;

/** The generic testnet USDT, not the 6-decimal Venus mock. Nothing here reads its decimals. */
export const BSC_TESTNET_PROBE_CONTRACT = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd" as const;

export const DEFAULT_RPC_URLS: Readonly<Record<number, string>> = {
  [BSC_MAINNET]: "https://bsc-rpc.publicnode.com",
  [BSC_TESTNET]: "https://bsc-testnet-rpc.publicnode.com",
};

export const DEFAULT_PROBE_CONTRACTS: Readonly<Record<number, string>> = {
  [BSC_MAINNET]: BSC_MAINNET_PROBE_CONTRACT,
  [BSC_TESTNET]: BSC_TESTNET_PROBE_CONTRACT,
};

export function defaultProbeContract(chainId: number): string {
  const contract = DEFAULT_PROBE_CONTRACTS[chainId];
  if (contract === undefined) {
    throw new Error(
      `no default probe contract for chain ${chainId}; pass one explicitly, and make sure it predates the deepest block the search will reach`,
    );
  }
  return contract;
}

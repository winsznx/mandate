/**
 * Protocol readings, in the form the artifact publishes them.
 *
 * `@mandate/venus-bsc` returns a Venus-shaped observation. The evidence schema
 * publishes a protocol-neutral one, and the translation lives here rather than
 * in either of them: the adapter should not know about evidence documents, and
 * the domain package should not take a dependency on any one protocol.
 *
 * Nothing is dropped, combined or rounded on the way through. In particular
 * every `null` survives. A market the chain refused to report is unknown
 * exposure, and the entire fail-closed chain downstream depends on being able
 * to tell that apart from a market with nothing in it.
 */
import type { Address } from "viem";
import type { PublicClient } from "viem";
import type { RawProtocolObservation } from "@mandate/domain";
import { observeAccount, type RawVenusObservation, type VenusDeployment } from "@mandate/venus-bsc";
import { TrialInfrastructureError } from "./errors.js";

export const VENUS_PROTOCOL_ID = "venus";

/** Restate a Venus observation as the protocol-neutral document the artifact carries. */
export function toProtocolObservation(observation: RawVenusObservation): RawProtocolObservation {
  return {
    schemaVersion: observation.schemaVersion,
    protocolId: VENUS_PROTOCOL_ID,
    chainId: observation.chainId,
    account: observation.account,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
    comptroller: observation.comptroller,
    markets: observation.markets.map((market) => ({
      vToken: market.vToken,
      underlying: market.underlying,
      underlyingDecimals: market.underlyingDecimals,
      isListed: market.isListed,
      collateralFactorMantissa: market.collateralFactorMantissa,
      liquidationThresholdMantissa: market.liquidationThresholdMantissa,
      ...(market.metadataUnavailableReason === undefined
        ? {}
        : { metadataUnavailableReason: market.metadataUnavailableReason }),
      vTokenBalance: market.vTokenBalance,
      exchangeRateMantissa: market.exchangeRateMantissa,
      borrowBalance: market.borrowBalance,
      ...(market.balancesUnavailableReason === undefined
        ? {}
        : { balancesUnavailableReason: market.balancesUnavailableReason }),
      priceMantissa: market.priceMantissa,
      ...(market.priceUnavailableReason === undefined
        ? {}
        : { priceUnavailableReason: market.priceUnavailableReason }),
      entered: market.entered,
    })),
    enteredMarkets: [...observation.enteredMarkets],
    // VAI is the only non-market debt Venus has today. It travels as a list
    // because the next protocol will have more than one, and a reader that
    // learned to look for a single named field would miss them.
    nonMarketDebt: [
      {
        symbol: "VAI",
        controller: observation.vai.controller,
        mintedPrincipal: observation.vai.mintedPrincipal,
        repayAmount: observation.vai.repayAmount,
        decimals: observation.vai.decimals,
      },
    ],
    accountLiquidity: observation.accountLiquidity,
    implementations: observation.vTokenImplementations,
  };
}

const OBSERVATION_ATTEMPTS = 3;
const OBSERVATION_BACKOFF_MS = 1_500;

/**
 * Read the account at one block.
 *
 * Pinned to a single block on purpose. BSC produces a block every 0.45 s, so an
 * unpinned sweep of forty-six markets spans several blocks and can pair a
 * pre-repayment balance with a post-repayment liquidity figure — a snapshot of
 * a position that never existed.
 *
 * Retried because the sweep is hundreds of reads and the free BSC endpoints
 * drop connections under that load. Retrying is safe precisely because the read
 * is pinned: every attempt asks for the same block and either gets that state
 * or nothing, so a retry cannot stitch two different moments together.
 */
export async function observe(
  client: PublicClient,
  deployment: VenusDeployment,
  account: Address,
  blockNumber: bigint,
): Promise<RawVenusObservation> {
  let last: unknown;
  for (let attempt = 0; attempt < OBSERVATION_ATTEMPTS; attempt += 1) {
    try {
      return await observeAccount(client, deployment, account, { blockNumber });
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, OBSERVATION_BACKOFF_MS * (attempt + 1)));
    }
  }

  throw new TrialInfrastructureError(
    "OBSERVATION_FAILED",
    `could not read ${account} at block ${blockNumber} after ${OBSERVATION_ATTEMPTS} attempts: ${last instanceof Error ? last.message : String(last)}`,
  );
}

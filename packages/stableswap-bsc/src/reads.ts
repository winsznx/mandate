/**
 * Chain access. Facts in, facts out.
 *
 * Nothing here decides whether a price is attractive, which rung a grid sits on,
 * or how large a trade should be. Those judgements are made twice,
 * independently, by the agent and by the reference model.
 *
 * Every read is pinned to one block. BSC produces a block every 0.45 s, and an
 * unpinned sweep can pair a pool balance from one block with a stored rate from
 * the next, describing a pool state that never existed at any moment. On a
 * curve whose whole point is that small balance changes move the price
 * non-linearly, that is not a rounding difference.
 */
import { getAddress } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { ERC20_ABI, STABLESWAP_POOL_ABI } from "./abis.js";
import type { StableswapDeployment } from "./addresses.js";
import {
  STABLESWAP_OBSERVATION_SCHEMA_VERSION,
  type RawCoinObservation,
  type RawPoolQuote,
  type RawStableswapObservation,
} from "./observation.js";

function normalize(address: string): Address {
  return getAddress(address).toLowerCase() as Address;
}

function firstLine(error: unknown, fallback: string): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? fallback) : fallback;
}

export interface ObservePoolOptions {
  /** Pin every read to one block. Defaults to the current head. */
  blockNumber?: bigint;
  /** Trade size the recorded quotes are taken at. Defaults to one whole unit. */
  quoteSize?: bigint;
}

/** Observe a stableswap pool and one account's position against it, at a single block. */
export async function observePool(
  client: PublicClient,
  deployment: StableswapDeployment,
  account: Address,
  options: ObservePoolOptions = {},
): Promise<RawStableswapObservation> {
  const blockNumber = options.blockNumber ?? (await client.getBlockNumber());
  const block = await client.getBlock({ blockNumber });
  const at = { blockNumber } as const;
  const normalizedAccount = normalize(account);
  const quoteSize = options.quoteSize ?? 10n ** 18n;

  const parameters = await Promise.all([
    client.readContract({ address: deployment.pool, abi: STABLESWAP_POOL_ABI, functionName: "A", ...at }),
    client.readContract({ address: deployment.pool, abi: STABLESWAP_POOL_ABI, functionName: "fee", ...at }),
    client.readContract({ address: deployment.pool, abi: STABLESWAP_POOL_ABI, functionName: "offpeg_fee_multiplier", ...at }),
    client.readContract({ address: deployment.pool, abi: STABLESWAP_POOL_ABI, functionName: "get_virtual_price", ...at }),
    client.readContract({ address: deployment.pool, abi: STABLESWAP_POOL_ABI, functionName: "stored_rates", ...at }),
  ])
    .then(([amplification, feeBase, offpeg, virtualPrice, rates]) => ({
      amplification,
      feeBase,
      offpeg,
      virtualPrice,
      rates: rates as readonly bigint[],
      reason: undefined as string | undefined,
    }))
    .catch((error: unknown) => ({
      amplification: null,
      feeBase: null,
      offpeg: null,
      virtualPrice: null,
      rates: null,
      reason: firstLine(error, "the pool refused to report its parameters"),
    }));

  const coins: RawCoinObservation[] = await Promise.all(
    deployment.coins.map(async (coin): Promise<RawCoinObservation> => {
      const failures: string[] = [];

      async function read<T>(label: string, run: () => Promise<T>): Promise<T | null> {
        try {
          return await run();
        } catch (error) {
          failures.push(`${label}: ${firstLine(error, "reverted")}`);
          return null;
        }
      }

      const [poolBalance, walletBalance, walletAllowance, reportedDecimals] = await Promise.all([
        read("balances()", () =>
          client.readContract({ address: deployment.pool, abi: STABLESWAP_POOL_ABI, functionName: "balances", args: [BigInt(coin.index)], ...at }),
        ),
        read("balanceOf()", () =>
          client.readContract({ address: coin.token, abi: ERC20_ABI, functionName: "balanceOf", args: [normalizedAccount], ...at }),
        ),
        read("allowance()", () =>
          client.readContract({ address: coin.token, abi: ERC20_ABI, functionName: "allowance", args: [normalizedAccount, deployment.pool], ...at }),
        ),
        read("decimals()", () =>
          client.readContract({ address: coin.token, abi: ERC20_ABI, functionName: "decimals", ...at }),
        ),
      ]);

      // The rate comes out of the pool-level read, so it is absent as a group
      // rather than per coin. Recorded here anyway, because the consumer needs
      // it per coin and inferring which index it came from is exactly the kind
      // of implicit step that loses a coin.
      const storedRate = parameters.rates?.[coin.index] ?? null;

      return {
        index: coin.index,
        token: coin.token,
        symbol: coin.symbol,
        decimals: coin.decimals,
        reportedDecimals: reportedDecimals === null ? null : Number(reportedDecimals),
        poolBalance: poolBalance === null ? null : poolBalance.toString(10),
        storedRate: storedRate === null ? null : storedRate.toString(10),
        walletBalance: walletBalance === null ? null : walletBalance.toString(10),
        walletAllowance: walletAllowance === null ? null : walletAllowance.toString(10),
        ...(failures.length === 0 ? {} : { unavailableReason: failures.join("; ") }),
      };
    }),
  );

  const poolQuotes: RawPoolQuote[] = await Promise.all(
    deployment.coins.flatMap((from) =>
      deployment.coins
        .filter((to) => to.index !== from.index)
        .map(async (to): Promise<RawPoolQuote> => {
          try {
            const dy = await client.readContract({
              address: deployment.pool,
              abi: STABLESWAP_POOL_ABI,
              functionName: "get_dy",
              args: [BigInt(from.index), BigInt(to.index), quoteSize],
              ...at,
            });
            return {
              fromIndex: from.index,
              toIndex: to.index,
              dx: quoteSize.toString(10),
              dy: dy.toString(10),
            };
          } catch (error) {
            return {
              fromIndex: from.index,
              toIndex: to.index,
              dx: quoteSize.toString(10),
              dy: null,
              unavailableReason: firstLine(error, "get_dy reverted"),
            };
          }
        }),
    ),
  );

  return {
    schemaVersion: STABLESWAP_OBSERVATION_SCHEMA_VERSION,
    chainId: deployment.chainId,
    account: normalizedAccount,
    blockNumber: blockNumber.toString(10),
    blockHash: block.hash as Hex,
    pool: deployment.pool,
    amplification: parameters.amplification === null ? null : parameters.amplification.toString(10),
    feeBase: parameters.feeBase === null ? null : parameters.feeBase.toString(10),
    offpegFeeMultiplier: parameters.offpeg === null ? null : parameters.offpeg.toString(10),
    virtualPrice: parameters.virtualPrice === null ? null : parameters.virtualPrice.toString(10),
    coins,
    poolQuotes,
    ...(parameters.reason === undefined ? {} : { parametersUnavailableReason: parameters.reason }),
  };
}

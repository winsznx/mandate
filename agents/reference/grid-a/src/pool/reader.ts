/**
 * Pool state reads.
 *
 * `PoolReader` is an interface rather than a concrete client so the strategy can
 * be driven from fixed fixtures. A grid agent tested only against a live RPC is
 * tested against whatever the pool happened to hold that morning, and this pool
 * currently sits about 16 basis points off fair — inside the first rung of both
 * agents in this category, which is a state in which every branch that matters
 * is unreachable.
 *
 * Reads are strictly read-only. There is no signer here and no write path, by
 * construction rather than by convention.
 *
 * A reading that failed comes back `null` with a reason attached. Substituting a
 * zero would make an unreadable pool indistinguishable from a balanced one, and
 * a grid handed a zero price would read the market as infinitely dislocated and
 * trade its whole inventory into it.
 */
import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import type { ChainClient } from "@mandate/agent-runtime";
import { ERC20_ABI, POOL_ABI } from "./abi.js";
import type { PoolCoin, PoolDeployment } from "./addresses.js";

export interface CoinState {
  readonly index: number;
  readonly token: Address;
  readonly symbol: string;
  /** The configured value. Every balance in the ladder is scaled by it. */
  readonly decimals: number;
  /** What `decimals()` reported. `null` when the call reverted. */
  readonly reportedDecimals: number | null;
  readonly poolBalance: bigint | null;
  readonly storedRate: bigint | null;
  readonly walletBalance: bigint | null;
  /** What the account has approved the pool to pull. Never granted by a session. */
  readonly allowance: bigint | null;
}

export interface PoolState {
  readonly chainId: number;
  readonly pool: Address;
  readonly blockNumber: bigint;
  readonly account: Address;
  /** `EXTCODEHASH` of the pool at read time, for the pin check. */
  readonly codeHash: Hex | null;
  readonly virtualPrice: bigint | null;
  readonly coins: readonly CoinState[];
  /** The pool's own quote for the probe trade, coin 0 into coin 1. */
  readonly probeDy: bigint | null;
  /** The pool's own quote for one tranche, in whichever direction was asked. */
  readonly trancheQuotes: readonly TrancheQuote[];
  /** Set when any reading above came back `null`. Carried into the HOLD rationale. */
  readonly unreadableReason: string | undefined;
}

export interface TrancheQuote {
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly dx: bigint;
  readonly dy: bigint | null;
}

export interface PoolReader {
  readPoolState(account: Address, probeSize: bigint, trancheSize: bigint): Promise<PoolState>;
}

function normalize(value: string): Address {
  return getAddress(value).toLowerCase() as Address;
}

function firstLine(error: unknown, fallback: string): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? fallback) : fallback;
}

export function createPoolReader(client: ChainClient, deployment: PoolDeployment): PoolReader {
  return {
    async readPoolState(account: Address, probeSize: bigint, trancheSize: bigint): Promise<PoolState> {
      const normalized = normalize(account);
      // One block for every read. On a curve, price depends non-linearly on the
      // balances, so pairing a balance from one block with a rate from the next
      // describes a pool that never existed rather than one slightly out of date.
      const blockNumber = await client.getBlockNumber();
      const at = { blockNumber } as const;
      const failures: string[] = [];

      async function read<T>(label: string, run: () => Promise<T>): Promise<T | null> {
        try {
          return await run();
        } catch (error) {
          failures.push(`${label}: ${firstLine(error, "reverted")}`);
          return null;
        }
      }

      const [rates, virtualPrice, codeHash, probeDy] = await Promise.all([
        read("stored_rates()", () =>
          client.readContract({ address: deployment.pool, abi: POOL_ABI, functionName: "stored_rates", ...at }),
        ),
        read("get_virtual_price()", () =>
          client.readContract({ address: deployment.pool, abi: POOL_ABI, functionName: "get_virtual_price", ...at }),
        ),
        read("code hash", () => client.getBytecode({ address: deployment.pool, ...at }).then(hashOf)),
        read("get_dy() probe", () =>
          client.readContract({
            address: deployment.pool,
            abi: POOL_ABI,
            functionName: "get_dy",
            args: [0n, 1n, probeSize],
            ...at,
          }),
        ),
      ]);

      const coins = await Promise.all(
        deployment.coins.map((coin) => readCoin(client, deployment, coin, normalized, rates, at, read)),
      );

      const trancheQuotes = await Promise.all(
        deployment.coins.flatMap((from) =>
          deployment.coins
            .filter((to) => to.index !== from.index)
            .map(async (to): Promise<TrancheQuote> => ({
              fromIndex: from.index,
              toIndex: to.index,
              dx: trancheSize,
              dy: await read(`get_dy(${from.index},${to.index})`, () =>
                client.readContract({
                  address: deployment.pool,
                  abi: POOL_ABI,
                  functionName: "get_dy",
                  args: [BigInt(from.index), BigInt(to.index), trancheSize],
                  ...at,
                }),
              ),
            })),
        ),
      );

      return {
        chainId: deployment.chainId,
        pool: deployment.pool,
        blockNumber,
        account: normalized,
        codeHash,
        virtualPrice,
        coins,
        probeDy,
        trancheQuotes,
        unreadableReason: failures.length === 0 ? undefined : failures.join("; "),
      };
    },
  };
}

async function readCoin(
  client: ChainClient,
  deployment: PoolDeployment,
  coin: PoolCoin,
  account: Address,
  rates: readonly bigint[] | null,
  at: { readonly blockNumber: bigint },
  read: <T>(label: string, run: () => Promise<T>) => Promise<T | null>,
): Promise<CoinState> {
  const [poolBalance, walletBalance, allowance, reportedDecimals] = await Promise.all([
    read(`balances(${coin.index})`, () =>
      client.readContract({ address: deployment.pool, abi: POOL_ABI, functionName: "balances", args: [BigInt(coin.index)], ...at }),
    ),
    read(`${coin.symbol}.balanceOf()`, () =>
      client.readContract({ address: coin.token, abi: ERC20_ABI, functionName: "balanceOf", args: [account], ...at }),
    ),
    read(`${coin.symbol}.allowance()`, () =>
      client.readContract({ address: coin.token, abi: ERC20_ABI, functionName: "allowance", args: [account, deployment.pool], ...at }),
    ),
    read(`${coin.symbol}.decimals()`, () =>
      client.readContract({ address: coin.token, abi: ERC20_ABI, functionName: "decimals", ...at }),
    ),
  ]);

  return {
    index: coin.index,
    token: coin.token,
    symbol: coin.symbol,
    decimals: coin.decimals,
    reportedDecimals: reportedDecimals === null ? null : Number(reportedDecimals),
    poolBalance,
    storedRate: rates?.[coin.index] ?? null,
    walletBalance,
    allowance,
  };
}

/**
 * keccak of the deployed runtime, or `null` when the address holds no code.
 *
 * An address with no code is not a pool with unchanged code, and the two have
 * to stay distinguishable: the first is a chain the agent should refuse to act
 * against, and the second is the normal case.
 */
async function hashOf(bytecode: Hex | undefined): Promise<Hex | null> {
  if (bytecode === undefined || bytecode === "0x") return null;
  const { keccak256 } = await import("viem");
  return keccak256(bytecode);
}

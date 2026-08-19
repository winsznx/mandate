/**
 * Venus allocation-side state reads.
 *
 * `AllocationReader` is an interface rather than a concrete client so the
 * strategy can be driven from fixed fixtures. A rebalancing agent tested only
 * against a live RPC is tested against whatever the testnet faucet happened to
 * hand out that morning, and the states that decide this agent's behaviour — a
 * portfolio sitting exactly on its drift trigger, an over-weight market with no
 * idle capital behind the under-weight one — do not occur on demand.
 *
 * Reads are strictly read-only. There is no signer here and no write path, by
 * construction rather than by convention.
 *
 * Nothing in this file decides anything. A market whose reading failed comes
 * back with the field `null` and a reason attached, and the strategy is what
 * turns that into a refusal. Substituting a zero here would be worse in this
 * category than in any other: a zero position reads as maximally under-weight,
 * so an unreadable market would not merely be ignored, it would be the one the
 * agent chose to act on.
 */
import { getAddress } from "viem";
import type { Address } from "viem";
import type { ChainClient } from "@mandate/agent-runtime";
import { ACTION_MINT, COMPTROLLER_ABI, ERC20_ABI, ORACLE_ABI, VTOKEN_ABI } from "./abi.js";
import type { AllocationMarket, VenusAllocationDeployment } from "./addresses.js";

/** One market as this agent read it. Every fallible reading is nullable. */
export interface AllocationMarketState {
  readonly vToken: Address;
  readonly underlying: Address;
  readonly symbol: string;
  /** The configured value, which set the oracle scale used to price this market. */
  readonly underlyingDecimals: number;
  /** What `decimals()` reported. `null` when the call reverted. */
  readonly reportedDecimals: number | null;
  readonly isListed: boolean | null;
  readonly mintPaused: boolean | null;
  readonly supplyCapRaw: bigint | null;
  readonly exchangeRateMantissa: bigint | null;
  readonly totalSupplyVTokens: bigint | null;
  readonly priceMantissa: bigint | null;
  /** The account's own position in this market, in vToken units. */
  readonly vTokenBalance: bigint | null;
  /** Underlying sitting in the wallet, undeployed. */
  readonly walletBalance: bigint | null;
  /** What the wallet has approved the vToken to pull. Never granted by a session. */
  readonly allowance: bigint | null;
  readonly implementation: Address | null;
  /** Set when any reading above came back `null`. Carried into the HOLD rationale. */
  readonly unreadableReason: string | undefined;
}

export interface AllocationAccountState {
  readonly chainId: number;
  readonly account: Address;
  readonly blockNumber: bigint;
  readonly markets: readonly AllocationMarketState[];
}

export interface AllocationReader {
  readAccountState(account: Address): Promise<AllocationAccountState>;
}

function normalize(value: string): Address {
  return getAddress(value).toLowerCase() as Address;
}

function firstLine(error: unknown, fallback: string): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? fallback) : fallback;
}

export function createAllocationReader(
  client: ChainClient,
  deployment: VenusAllocationDeployment,
): AllocationReader {
  return {
    async readAccountState(account: Address): Promise<AllocationAccountState> {
      const normalized = normalize(account);
      // One block for every market. BSC produces a block every 0.45 s, and a
      // weight is a ratio between markets: pairing one market's balance with
      // another's from a later block computes the allocation of a portfolio
      // that never existed at any single moment.
      const blockNumber = await client.getBlockNumber();

      const markets = await Promise.all(
        deployment.markets.map((market) =>
          readMarket(client, deployment, market, normalized, blockNumber),
        ),
      );

      return { chainId: deployment.chainId, account: normalized, blockNumber, markets };
    },
  };
}

async function readMarket(
  client: ChainClient,
  deployment: VenusAllocationDeployment,
  market: AllocationMarket,
  account: Address,
  blockNumber: bigint,
): Promise<AllocationMarketState> {
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

  const [
    listing,
    mintPaused,
    supplyCapRaw,
    exchangeRateMantissa,
    totalSupplyVTokens,
    priceMantissa,
    vTokenBalance,
    walletBalance,
    allowance,
    reportedDecimals,
    implementation,
  ] = await Promise.all([
    read("markets()", () =>
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "markets", args: [market.vToken], ...at }),
    ),
    read("actionPaused(MINT)", () =>
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "actionPaused", args: [market.vToken, ACTION_MINT], ...at }),
    ),
    read("supplyCaps()", () =>
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "supplyCaps", args: [market.vToken], ...at }),
    ),
    read("exchangeRateStored()", () =>
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "exchangeRateStored", ...at }),
    ),
    read("totalSupply()", () =>
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "totalSupply", ...at }),
    ),
    read("getUnderlyingPrice()", () =>
      client.readContract({ address: deployment.oracle, abi: ORACLE_ABI, functionName: "getUnderlyingPrice", args: [market.vToken], ...at }),
    ),
    read("vToken.balanceOf()", () =>
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "balanceOf", args: [account], ...at }),
    ),
    read("underlying.balanceOf()", () =>
      client.readContract({ address: market.underlying, abi: ERC20_ABI, functionName: "balanceOf", args: [account], ...at }),
    ),
    read("underlying.allowance()", () =>
      client.readContract({ address: market.underlying, abi: ERC20_ABI, functionName: "allowance", args: [account, market.vToken], ...at }),
    ),
    read("underlying.decimals()", () =>
      client.readContract({ address: market.underlying, abi: ERC20_ABI, functionName: "decimals", ...at }),
    ),
    read("implementation()", () =>
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "implementation", ...at }),
    ),
  ]);

  return {
    vToken: market.vToken,
    underlying: market.underlying,
    symbol: market.symbol,
    underlyingDecimals: market.underlyingDecimals,
    reportedDecimals: reportedDecimals === null ? null : Number(reportedDecimals),
    isListed: listing === null ? null : listing[0],
    mintPaused,
    supplyCapRaw,
    exchangeRateMantissa,
    totalSupplyVTokens,
    priceMantissa,
    vTokenBalance,
    walletBalance,
    allowance,
    implementation: implementation === null ? null : normalize(implementation),
    unreadableReason: failures.length === 0 ? undefined : failures.join("; "),
  };
}

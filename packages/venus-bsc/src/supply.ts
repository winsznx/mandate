/**
 * The supply side of Venus, as raw readings.
 *
 * Same discipline as `observation.ts`, applied to a different question. This
 * module answers "what does the chain say about supplying into these markets"
 * and stops there. It exports no `bestMarket`, no `annualisedRate`, no
 * `isWorthMoving`. The agent and the reference model both read from here and
 * then reason separately, which is the only reason a supply-side trial means
 * anything.
 *
 * Three readings here exist because leaving them out produces a proposal that
 * reverts rather than one that is merely suboptimal:
 *
 *   `mintPaused` — testnet vBUSD is a listed market, carries a price, and
 *   rejects every `mint`. A reader that filters on `isListed` alone proposes
 *   into it.
 *
 *   `supplyCap` — a market at its ceiling rejects the mint that would cross it.
 *   Venus writes the cap as zero on retired markets, which means "no supply
 *   accepted", not "no limit".
 *
 *   `allowance` — `mint` pulls the underlying with `transferFrom`. The
 *   allowance is granted by the account's admin key and never by a session, so
 *   an agent that assumes it exists proposes a call the user's own account will
 *   fail to make.
 *
 * Rates are recorded per block, exactly as the protocol reports them. Venus's
 * interest-rate model on chain 97 sits behind a proxy that reverts on
 * `blocksOrSecondsPerYear()`, so there is no annualisation constant to read.
 * Any yearly figure is a stated convention, which makes it a policy input
 * rather than a fact, and facts are all this module carries.
 */
import { getAddress } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { COMPTROLLER_ABI, ERC20_ABI, ORACLE_ABI, VENUS_ACTION_MINT, VTOKEN_ABI } from "./abis.js";
import type { VenusDeployment } from "./addresses.js";

export const VENUS_SUPPLY_OBSERVATION_SCHEMA_VERSION = "mandate.venus-supply-observation/1" as const;

/**
 * A market a supply-side agent may be pointed at.
 *
 * `underlyingDecimals` is configuration rather than a runtime read for the same
 * reason it is in `VenusDeployment`: the oracle scale is `1e(36 - decimals)`,
 * the testnet mocks are 6 dp where mainnet is 18, and a wrong value is an error
 * of twelve orders of magnitude rather than a rounding difference. The
 * observation reads `decimals()` anyway and records the disagreement.
 */
export interface SupplyMarketConfig {
  readonly vToken: Address;
  readonly underlying: Address;
  readonly symbol: string;
  readonly underlyingDecimals: number;
}

/**
 * The Venus Core-pool stablecoin markets on BSC testnet 97.
 *
 * Every field was read back off the live chain. vBUSD is listed here on
 * purpose even though it accepts nothing: it is a retired market that is still
 * `isListed`, still priced by the oracle, and has `mintPaused == true` with a
 * supply cap of zero. Keeping it in the configured universe is what makes the
 * availability filter a tested path rather than an untested branch.
 */
export const VENUS_SUPPLY_MARKETS_BSC_TESTNET: readonly SupplyMarketConfig[] = [
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
];

export const VENUS_SUPPLY_MARKETS: Readonly<Record<number, readonly SupplyMarketConfig[]>> = {
  97: VENUS_SUPPLY_MARKETS_BSC_TESTNET,
};

export function venusSupplyMarketsFor(chainId: number): readonly SupplyMarketConfig[] {
  const markets = VENUS_SUPPLY_MARKETS[chainId];
  if (markets === undefined) {
    throw new Error(`no Venus supply markets configured for chain ${chainId}`);
  }
  return markets;
}

/**
 * One market's supply state, exactly as read.
 *
 * Every quantity that the chain could refuse to answer is nullable, and no
 * absence is defaulted. A market whose rate could not be read is a market of
 * unknown yield, not a market yielding nothing, and the difference decides
 * whether a correct agent deploys into it.
 */
export interface RawSupplyMarketObservation {
  readonly vToken: Address;
  readonly underlying: Address;
  readonly symbol: string;
  /** The configured value the oracle scale was derived from. */
  readonly underlyingDecimals: number;
  /**
   * `decimals()` as the token actually reports it.
   *
   * Recorded separately from the configured value so a consumer can see the two
   * agree rather than trusting that they do. `null` when the call reverted.
   */
  readonly reportedUnderlyingDecimals: number | null;
  readonly isListed: boolean | null;
  /** `Comptroller.actionPaused(market, MINT)`. `null` when the call reverted. */
  readonly mintPaused: boolean | null;
  /** Ceiling on total supply in underlying units. Zero means the market accepts nothing. */
  readonly supplyCapRaw: string | null;
  readonly metadataUnavailableReason?: string;
  /** Interest per block at 1e18, from `supplyRatePerBlock`. Never annualised here. */
  readonly supplyRatePerBlockMantissa: string | null;
  readonly exchangeRateMantissa: string | null;
  /** vToken units in existence. Multiplied by the exchange rate this is the supplied total. */
  readonly totalSupplyVTokens: string | null;
  /**
   * The three components of the market's balance sheet.
   *
   * `cash + borrows - reserves` is the same underlying total that
   * `totalSupplyVTokens * exchangeRate` gives, by the exchange-rate identity.
   * Both are recorded so that two implementations can reach the figure by
   * different routes and a disagreement between them stays visible instead of
   * being averaged into a single reported number.
   */
  readonly cashRaw: string | null;
  readonly totalBorrowsRaw: string | null;
  readonly totalReservesRaw: string | null;
  readonly rateUnavailableReason?: string;
  /** The account's own vToken balance, in vToken units. */
  readonly vTokenBalance: string | null;
  /** Underlying sitting in the wallet, undeployed. */
  readonly walletUnderlyingBalance: string | null;
  /** What the wallet has approved this vToken to pull. Granted by the admin key, never a session. */
  readonly walletAllowance: string | null;
  readonly balancesUnavailableReason?: string;
  /** Oracle price at the Venus scale of `1e(36 - underlyingDecimals)`. */
  readonly priceMantissa: string | null;
  readonly priceUnavailableReason?: string;
  /** Implementation behind the delegator at read time, for the profile pin. */
  readonly implementation: Address | null;
}

export interface RawSupplyObservation {
  readonly schemaVersion: typeof VENUS_SUPPLY_OBSERVATION_SCHEMA_VERSION;
  readonly chainId: number;
  readonly account: Address;
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly comptroller: Address;
  readonly markets: readonly RawSupplyMarketObservation[];
}

function normalize(address: string): Address {
  return getAddress(address).toLowerCase() as Address;
}

function firstLine(error: Error, fallback: string): string {
  return error.message.split("\n")[0] ?? fallback;
}

async function observeSupplyMarket(
  client: PublicClient,
  deployment: VenusDeployment,
  market: SupplyMarketConfig,
  account: Address,
  blockNumber: bigint,
): Promise<RawSupplyMarketObservation> {
  const at = { blockNumber } as const;

  // Grouped by the contract that answers, so one unreachable contract
  // invalidates one group rather than the whole market. A market with readable
  // balances and an unreadable cap is a real state, and the consumer has to be
  // able to see it rather than being handed a market that silently lost a field.
  const [metadata, rates, balances, price, implementation] = await Promise.all([
    Promise.all([
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "markets", args: [market.vToken], ...at }),
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "actionPaused", args: [market.vToken, VENUS_ACTION_MINT], ...at }),
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "supplyCaps", args: [market.vToken], ...at }),
    ])
      .then(([listing, paused, cap]) => ({ listing, paused, cap, reason: undefined as string | undefined }))
      .catch((error: Error) => ({
        listing: null,
        paused: null,
        cap: null,
        reason: firstLine(error, "the Comptroller refused to report this market"),
      })),

    Promise.all([
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "supplyRatePerBlock", ...at }),
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "exchangeRateStored", ...at }),
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "totalSupply", ...at }),
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "getCash", ...at }),
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "totalBorrows", ...at }),
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "totalReserves", ...at }),
    ])
      .then(([rate, exchangeRate, totalSupply, cash, borrows, reserves]) => ({
        rate,
        exchangeRate,
        totalSupply,
        cash,
        borrows,
        reserves,
        reason: undefined as string | undefined,
      }))
      .catch((error: Error) => ({
        rate: null,
        exchangeRate: null,
        totalSupply: null,
        cash: null,
        borrows: null,
        reserves: null,
        reason: firstLine(error, "the vToken refused to report its rate"),
      })),

    Promise.all([
      client.readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "balanceOf", args: [account], ...at }),
      client.readContract({ address: market.underlying, abi: ERC20_ABI, functionName: "balanceOf", args: [account], ...at }),
      client.readContract({ address: market.underlying, abi: ERC20_ABI, functionName: "allowance", args: [account, market.vToken], ...at }),
      client.readContract({ address: market.underlying, abi: ERC20_ABI, functionName: "decimals", ...at }),
    ])
      .then(([vTokenBalance, walletBalance, allowance, decimals]) => ({
        vTokenBalance,
        walletBalance,
        allowance,
        decimals: Number(decimals) as number | null,
        reason: undefined as string | undefined,
      }))
      .catch((error: Error) => ({
        vTokenBalance: null,
        walletBalance: null,
        allowance: null,
        decimals: null,
        reason: firstLine(error, "a balance read reverted"),
      })),

    client
      .readContract({ address: deployment.oracle, abi: ORACLE_ABI, functionName: "getUnderlyingPrice", args: [market.vToken], ...at })
      .then((value) => ({ mantissa: value.toString(10) as string | null, reason: undefined as string | undefined }))
      .catch((error: Error) => ({ mantissa: null, reason: firstLine(error, "the oracle refused to price this market") })),

    client
      .readContract({ address: market.vToken, abi: VTOKEN_ABI, functionName: "implementation", ...at })
      .then((value) => normalize(value))
      .catch(() => null),
  ]);

  return {
    vToken: market.vToken,
    underlying: market.underlying,
    symbol: market.symbol,
    underlyingDecimals: market.underlyingDecimals,
    reportedUnderlyingDecimals: balances.decimals,
    isListed: metadata.listing === null ? null : metadata.listing[0],
    mintPaused: metadata.paused,
    supplyCapRaw: metadata.cap === null ? null : metadata.cap.toString(10),
    ...(metadata.reason === undefined ? {} : { metadataUnavailableReason: metadata.reason }),
    supplyRatePerBlockMantissa: rates.rate === null ? null : rates.rate.toString(10),
    exchangeRateMantissa: rates.exchangeRate === null ? null : rates.exchangeRate.toString(10),
    totalSupplyVTokens: rates.totalSupply === null ? null : rates.totalSupply.toString(10),
    cashRaw: rates.cash === null ? null : rates.cash.toString(10),
    totalBorrowsRaw: rates.borrows === null ? null : rates.borrows.toString(10),
    totalReservesRaw: rates.reserves === null ? null : rates.reserves.toString(10),
    ...(rates.reason === undefined ? {} : { rateUnavailableReason: rates.reason }),
    vTokenBalance: balances.vTokenBalance === null ? null : balances.vTokenBalance.toString(10),
    walletUnderlyingBalance: balances.walletBalance === null ? null : balances.walletBalance.toString(10),
    walletAllowance: balances.allowance === null ? null : balances.allowance.toString(10),
    ...(balances.reason === undefined ? {} : { balancesUnavailableReason: balances.reason }),
    priceMantissa: price.mantissa,
    ...(price.reason === undefined ? {} : { priceUnavailableReason: price.reason }),
    implementation,
  };
}

export interface ObserveSupplyOptions {
  /** Pin every read to one block. Defaults to the current head. */
  blockNumber?: bigint;
  /** Restrict the universe. Omit to read every configured market for the chain. */
  markets?: readonly SupplyMarketConfig[];
}

/**
 * Observe the supply side of an account's Venus position at a single block.
 *
 * Pinned to one block for the same reason the solvency read is: BSC produces a
 * block every 0.45 s, and an unpinned sweep can pair a pre-deposit wallet
 * balance with a post-deposit vToken balance, describing a position that never
 * existed at any moment.
 */
export async function observeSupply(
  client: PublicClient,
  deployment: VenusDeployment,
  account: Address,
  options: ObserveSupplyOptions = {},
): Promise<RawSupplyObservation> {
  const blockNumber = options.blockNumber ?? (await client.getBlockNumber());
  const block = await client.getBlock({ blockNumber });
  const normalizedAccount = normalize(account);
  const universe = options.markets ?? venusSupplyMarketsFor(deployment.chainId);

  const markets = await Promise.all(
    universe.map((market) =>
      observeSupplyMarket(client, deployment, market, normalizedAccount, blockNumber),
    ),
  );

  return {
    schemaVersion: VENUS_SUPPLY_OBSERVATION_SCHEMA_VERSION,
    chainId: deployment.chainId,
    account: normalizedAccount,
    blockNumber: blockNumber.toString(10),
    blockHash: block.hash as Hex,
    comptroller: deployment.comptroller,
    markets,
  };
}

/**
 * Markets whose supply state could not be fully read.
 *
 * The fail-closed trigger for every supply-side consumer. A market whose rate,
 * price or availability is unknown cannot be compared against one whose is, and
 * an allocation computed over the readable subset silently answers a different
 * question from the one that was asked.
 */
export function marketsWithUnreadableSupplyState(
  observation: RawSupplyObservation,
): readonly RawSupplyMarketObservation[] {
  return observation.markets.filter(
    (market) =>
      market.isListed === null ||
      market.mintPaused === null ||
      market.supplyCapRaw === null ||
      market.supplyRatePerBlockMantissa === null ||
      market.exchangeRateMantissa === null ||
      market.totalSupplyVTokens === null ||
      market.cashRaw === null ||
      market.totalBorrowsRaw === null ||
      market.totalReservesRaw === null ||
      market.vTokenBalance === null ||
      market.walletUnderlyingBalance === null ||
      market.walletAllowance === null ||
      market.priceMantissa === null,
  );
}

/**
 * Markets whose configured decimals disagree with what the token reports.
 *
 * A factual comparison, not a judgement. It is separated out because the
 * consequence is not proportional to the size of the disagreement: the oracle
 * scale is `1e(36 - decimals)`, so a single-digit difference misprices the
 * market by orders of magnitude.
 */
export function marketsWithDecimalsDisagreement(
  observation: RawSupplyObservation,
): readonly RawSupplyMarketObservation[] {
  return observation.markets.filter(
    (market) =>
      market.reportedUnderlyingDecimals !== null &&
      market.reportedUnderlyingDecimals !== market.underlyingDecimals,
  );
}

/**
 * Markets that would accept a supply right now.
 *
 * Listed, mint not paused, and total supply below the cap. This says which
 * markets are open, never which one is worth using — the ranking is the
 * judgement each side of the trial has to make on its own.
 *
 * A market missing any of the three readings is excluded, because "unknown" and
 * "open" must not collapse into the same answer.
 */
export function marketsAcceptingSupply(
  observation: RawSupplyObservation,
): readonly RawSupplyMarketObservation[] {
  return observation.markets.filter((market) => {
    if (market.isListed !== true || market.mintPaused !== false) return false;
    if (market.supplyCapRaw === null || market.exchangeRateMantissa === null) return false;
    if (market.totalSupplyVTokens === null) return false;
    const cap = BigInt(market.supplyCapRaw);
    if (cap === 0n) return false;
    // Total supplied underlying is vToken supply scaled by the exchange rate,
    // which is what the Comptroller compares the cap against.
    const supplied =
      (BigInt(market.totalSupplyVTokens) * BigInt(market.exchangeRateMantissa)) / 10n ** 18n;
    return supplied < cap;
  });
}

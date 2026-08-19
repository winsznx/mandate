/**
 * Fixed Venus supply observations, in the raw form the adapter emits.
 *
 * Scales are the ones read off chain 97: both stablecoin mocks are 6 decimals,
 * USDT prices at `5e29` (fifty cents at the `1e(36 - decimals)` scaling) and
 * USDC at `1e30` (a dollar). Two markets with the same decimals and different
 * prices is the pairing that catches a model that ranks in one currency and
 * sizes in another.
 *
 * The balance sheet and the vToken supply are kept consistent with each other
 * on purpose. This model reads `cash + borrows - reserves` and reports its
 * disagreement with `totalSupply * exchangeRate` as drift, so a fixture that
 * let them drift for no reason would put noise into every test that is not
 * about drift. The one test that is about drift sets it deliberately.
 */
import type { RawSupplyMarketObservation, RawSupplyObservation } from "@mandate/venus-bsc";
import type { Address, Hex } from "viem";
import type { ReferenceYieldPolicy } from "../src/model.js";

export const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
export const COMPTROLLER = "0x94d1820b2d1c7c7452a163983dc888cec546b77d" as Address;
export const IMPLEMENTATION = "0x73ff75092da265b87b25ffb943c47c90419a04a6" as Address;

export const VUSDT = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as Address;
export const VUSDC = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7" as Address;
export const VBUSD = "0x08e0a5575de71037ae36abfafb516595fe68e5e4" as Address;

export const USDT = "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c" as Address;
export const USDC = "0x16227d60f7a0e586c66b005219dfc887d13c9531" as Address;
export const BUSD = "0x8301f2213c0eed49a7e28ae4c3e91722919b8b47" as Address;

export const USDT_PRICE_6DP = 5n * 10n ** 29n;
export const USDC_PRICE_6DP = 10n ** 30n;
export const BUSD_PRICE_18DP = 10n ** 18n;

export const MINT_SELECTOR = "0xa0712d68" as Hex;

export const BLOCK = "125929412";
export const BLOCK_HASH = `0x${"ab".repeat(32)}` as Hex;

export const UNCAPPED = ((1n << 256n) - 1n).toString(10);

/** The exchange rate the live stablecoin markets sit at, to the order of magnitude. */
export const EXCHANGE_RATE = 2n * 10n ** 14n;

export const BLOCKS_PER_YEAR = 10_000_000;

/**
 * The policy the tests run against.
 *
 * The same numbers the reference agent publishes, restated here rather than
 * imported. The duplication is deliberate: a test that read the agent's
 * constants would pass whenever the agent and this model agreed with each
 * other, including when both were wrong.
 */
export const TEST_POLICY: ReferenceYieldPolicy = {
  policyId: "cost-aware-optimizer",
  minNetSupplyRateBps: 75,
  gasCostBufferBps: 25,
  blocksPerYear: BLOCKS_PER_YEAR,
  minDeploymentUsdMantissa: 10n * 10n ** 18n,
  maxVenueShareBps: null,
  amountToleranceBps: 50,
};

/** The diversified sibling's policy, for the tests that exercise the ceiling. */
export const CAPPED_POLICY: ReferenceYieldPolicy = {
  ...TEST_POLICY,
  policyId: "diversified-optimizer",
  minNetSupplyRateBps: 50,
  maxVenueShareBps: 6_000,
};

/** A per-block rate that annualises to `bps` under the published convention. */
export function ratePerBlockForAnnualBps(bps: number): bigint {
  return (BigInt(bps) * 10n ** 18n) / (BigInt(BLOCKS_PER_YEAR) * 10_000n);
}

export interface MarketFixture {
  readonly vToken: Address;
  readonly underlying: Address;
  readonly symbol: string;
  readonly underlyingDecimals: number;
  readonly priceMantissa: bigint;
  readonly annualRateBps: number;
  readonly walletBalance: bigint;
  readonly allowance?: bigint;
  readonly vTokenBalance?: bigint;
  /** Underlying the market holds. Split across cash and borrows by the helper. */
  readonly suppliedUnderlying?: bigint;
  readonly supplyCapRaw?: string;
  readonly isListed?: boolean | null;
  readonly mintPaused?: boolean | null;
  readonly reportedDecimals?: number | null;
  /** Overrides the derived `totalSupply`, so a test can force an identity mismatch. */
  readonly totalSupplyVTokens?: bigint;
  readonly overrides?: Partial<RawSupplyMarketObservation>;
}

/**
 * One market, with its balance sheet derived from the underlying it holds.
 *
 * `cash + borrows - reserves` and `totalSupply * exchangeRate` are made to
 * agree by construction: the helper picks a cash and a borrow that sum to the
 * supplied total, and derives the vToken supply from the same figure.
 */
export function market(fixture: MarketFixture): RawSupplyMarketObservation {
  const supplied = fixture.suppliedUnderlying ?? 1_000_000_000n;
  const borrows = supplied / 4n;
  const reserves = 0n;
  const cash = supplied - borrows;
  const totalSupply = fixture.totalSupplyVTokens ?? (supplied * 10n ** 18n) / EXCHANGE_RATE;

  return {
    vToken: fixture.vToken,
    underlying: fixture.underlying,
    symbol: fixture.symbol,
    underlyingDecimals: fixture.underlyingDecimals,
    reportedUnderlyingDecimals:
      fixture.reportedDecimals === undefined ? fixture.underlyingDecimals : fixture.reportedDecimals,
    isListed: fixture.isListed ?? true,
    mintPaused: fixture.mintPaused ?? false,
    supplyCapRaw: fixture.supplyCapRaw ?? UNCAPPED,
    supplyRatePerBlockMantissa: ratePerBlockForAnnualBps(fixture.annualRateBps).toString(10),
    exchangeRateMantissa: EXCHANGE_RATE.toString(10),
    totalSupplyVTokens: totalSupply.toString(10),
    cashRaw: cash.toString(10),
    totalBorrowsRaw: borrows.toString(10),
    totalReservesRaw: reserves.toString(10),
    vTokenBalance: (fixture.vTokenBalance ?? 0n).toString(10),
    walletUnderlyingBalance: fixture.walletBalance.toString(10),
    walletAllowance: (fixture.allowance ?? fixture.walletBalance).toString(10),
    priceMantissa: fixture.priceMantissa.toString(10),
    implementation: IMPLEMENTATION,
    ...fixture.overrides,
  };
}

/** vBUSD as chain 97 holds it: listed, priced, mint paused, supply cap zero. */
export function retiredBusd(walletBalance = 0n): RawSupplyMarketObservation {
  return market({
    vToken: VBUSD,
    underlying: BUSD,
    symbol: "BUSD",
    underlyingDecimals: 18,
    priceMantissa: BUSD_PRICE_18DP,
    annualRateBps: 5_000,
    walletBalance,
    mintPaused: true,
    supplyCapRaw: "0",
    suppliedUnderlying: 1_000n * 10n ** 18n,
  });
}

export function observation(markets: readonly RawSupplyMarketObservation[]): RawSupplyObservation {
  return {
    schemaVersion: "mandate.venus-supply-observation/1",
    chainId: 97,
    account: ACCOUNT,
    blockNumber: BLOCK,
    blockHash: BLOCK_HASH,
    comptroller: COMPTROLLER,
    markets,
  };
}

export interface SideFixture {
  readonly annualRateBps: number;
  readonly walletBalance: bigint;
  readonly vTokenBalance?: bigint;
}

/** The canonical two-market board, with the retired BUSD market alongside. */
export function position(usdt: SideFixture, usdc: SideFixture): RawSupplyObservation {
  return observation([
    market({
      vToken: VUSDT,
      underlying: USDT,
      symbol: "USDT",
      underlyingDecimals: 6,
      priceMantissa: USDT_PRICE_6DP,
      annualRateBps: usdt.annualRateBps,
      walletBalance: usdt.walletBalance,
      ...(usdt.vTokenBalance === undefined ? {} : { vTokenBalance: usdt.vTokenBalance }),
    }),
    market({
      vToken: VUSDC,
      underlying: USDC,
      symbol: "USDC",
      underlyingDecimals: 6,
      priceMantissa: USDC_PRICE_6DP,
      annualRateBps: usdc.annualRateBps,
      walletBalance: usdc.walletBalance,
      ...(usdc.vTokenBalance === undefined ? {} : { vTokenBalance: usdc.vTokenBalance }),
    }),
    retiredBusd(),
  ]);
}

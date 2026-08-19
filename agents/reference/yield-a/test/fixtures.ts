/**
 * Fixed Venus supply states.
 *
 * The scales are the ones read off chain 97 rather than friendlier round
 * numbers. The mock USDT is 6 decimals and the oracle prices it at $0.50, which
 * makes `5e29` the correct mantissa at the `1e(36 - decimals)` scaling; USDC is
 * also 6 decimals and prices at $1.00, so `1e30`. The two markets therefore have
 * the same decimals and different prices, which is the pairing that catches a
 * strategy that ranks by rate and then sizes in the wrong currency.
 *
 * Rates are stated per block, as the protocol reports them, and the helper
 * converts from the annual basis points a reader can reason about. On chain 97
 * both stablecoin markets currently report a supply rate of exactly zero, so a
 * fixture is the only way to reach the branches that matter.
 */
import type { Address } from "viem";
import { VENUS_SUPPLY_BSC_TESTNET } from "../src/venus/addresses.js";
import type { SupplyAccountState, SupplyMarketState, SupplyReader } from "../src/venus/reader.js";
import { BLOCKS_PER_YEAR } from "../src/policy.js";

export const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;

export const VUSDT = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as Address;
export const VUSDC = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7" as Address;
export const VBUSD = "0x08e0a5575de71037ae36abfafb516595fe68e5e4" as Address;

/** 6-decimal underlying priced at $0.50, as on chain 97. */
export const USDT_PRICE_6DP = 5n * 10n ** 29n;
/** 6-decimal underlying priced at $1.00, as on chain 97. */
export const USDC_PRICE_6DP = 10n ** 30n;
/** 18-decimal underlying priced at $1.00. */
export const BUSD_PRICE_18DP = 10n ** 18n;

export const BLOCK = 125_929_412n;

/** No practical ceiling, which is what both live stablecoin markets carry. */
export const UNCAPPED = (1n << 256n) - 1n;

/**
 * A per-block rate that annualises to `bps` under the published convention.
 *
 * Exact rather than approximate: `bps * 1e18 / (blocksPerYear * 10000)` divides
 * without remainder for every value used here, so a test asserting a boundary
 * is asserting the boundary and not a rounding artefact one unit away from it.
 */
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
  readonly supplyCapRaw?: bigint;
  readonly totalSupplyVTokens?: bigint;
  readonly exchangeRateMantissa?: bigint;
  readonly isListed?: boolean;
  readonly mintPaused?: boolean;
  readonly reportedDecimals?: number | null;
  readonly implementation?: Address | null;
  readonly unreadableReason?: string;
}

export function market(fixture: MarketFixture): SupplyMarketState {
  return {
    vToken: fixture.vToken,
    underlying: fixture.underlying,
    symbol: fixture.symbol,
    underlyingDecimals: fixture.underlyingDecimals,
    reportedDecimals:
      fixture.reportedDecimals === undefined ? fixture.underlyingDecimals : fixture.reportedDecimals,
    isListed: fixture.isListed ?? true,
    mintPaused: fixture.mintPaused ?? false,
    supplyCapRaw: fixture.supplyCapRaw ?? UNCAPPED,
    supplyRatePerBlockMantissa: ratePerBlockForAnnualBps(fixture.annualRateBps),
    // A fifth of a unit per vToken, which is the order the live markets sit at.
    exchangeRateMantissa: fixture.exchangeRateMantissa ?? 2n * 10n ** 14n,
    totalSupplyVTokens: fixture.totalSupplyVTokens ?? 10n ** 18n,
    priceMantissa: fixture.priceMantissa,
    vTokenBalance: fixture.vTokenBalance ?? 0n,
    walletBalance: fixture.walletBalance,
    allowance: fixture.allowance ?? fixture.walletBalance,
    implementation:
      fixture.implementation === undefined
        ? VENUS_SUPPLY_BSC_TESTNET.vTokenImplementation
        : fixture.implementation,
    unreadableReason: fixture.unreadableReason,
  };
}

export interface UsdtFixture {
  readonly annualRateBps: number;
  readonly walletBalance: bigint;
  readonly vTokenBalance?: bigint;
}

export interface UsdcFixture extends UsdtFixture {}

/**
 * The canonical two-market state: USDT at one rate, USDC at another, BUSD
 * retired.
 *
 * BUSD is present in every fixture because it is present on chain: listed,
 * priced, mint paused, supply cap zero. A strategy that filters on `isListed`
 * alone ranks it wherever its rate falls, so leaving it out of the fixtures
 * would leave the filter untested.
 */
export function position(usdt: UsdtFixture, usdc: UsdcFixture): SupplyAccountState {
  return state([
    market({
      vToken: VUSDT,
      underlying: "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c" as Address,
      symbol: "USDT",
      underlyingDecimals: 6,
      priceMantissa: USDT_PRICE_6DP,
      annualRateBps: usdt.annualRateBps,
      walletBalance: usdt.walletBalance,
      ...(usdt.vTokenBalance === undefined ? {} : { vTokenBalance: usdt.vTokenBalance }),
    }),
    market({
      vToken: VUSDC,
      underlying: "0x16227d60f7a0e586c66b005219dfc887d13c9531" as Address,
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

/**
 * vBUSD as chain 97 actually holds it: listed, priced, and accepting nothing.
 *
 * It carries the highest rate in every fixture, so a strategy that ignores the
 * pause flag ranks it first and is caught rather than accidentally correct.
 *
 * The idle balance defaults to zero. A retired stablecoin sitting in the wallet
 * is a real case and it has its own test, but it is not the default one, and
 * folding it into every fixture would silently move the denominator of any
 * concentration ceiling under test.
 */
export function retiredBusd(walletBalance = 0n): SupplyMarketState {
  return market({
    vToken: VBUSD,
    underlying: "0x8301f2213c0eed49a7e28ae4c3e91722919b8b47" as Address,
    symbol: "BUSD",
    underlyingDecimals: 18,
    priceMantissa: BUSD_PRICE_18DP,
    annualRateBps: 5_000,
    walletBalance,
    mintPaused: true,
    supplyCapRaw: 0n,
  });
}

export function state(markets: readonly SupplyMarketState[]): SupplyAccountState {
  return {
    chainId: VENUS_SUPPLY_BSC_TESTNET.chainId,
    account: ACCOUNT,
    blockNumber: BLOCK,
    markets,
  };
}

export function fixedReader(accountState: SupplyAccountState): SupplyReader {
  return { readAccountState: () => Promise.resolve(accountState) };
}

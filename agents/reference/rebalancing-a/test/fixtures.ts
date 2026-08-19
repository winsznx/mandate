/**
 * Fixed Venus portfolio states.
 *
 * The scales are the ones read off chain 97 rather than friendlier round
 * numbers. The mock USDT is 6 decimals and the oracle prices it at $0.50, which
 * makes `5e29` the correct mantissa at the `1e(36 - decimals)` scaling; USDC is
 * also 6 decimals and prices at $1.00, so `1e30`; BUSD is 18 decimals and reads
 * `999777700000000000`, which is the live figure and not quite a dollar. Two
 * markets with the same decimals and different prices is the pairing that
 * catches a strategy that measures weights in token units instead of dollars —
 * an equal-weight portfolio of 1000 USDT and 1000 USDC is two thirds USDC.
 *
 * Positions are stated in underlying base units and converted to vToken units
 * by the helper, because that is how the arithmetic is easiest to check by
 * hand. At the fixture exchange rate of `2e14` one base unit of underlying is
 * exactly 5000 vToken units, so every position here is representable without a
 * remainder and the agent's two-step valuation and the reference model's
 * single-division one agree to the wei. That matters for the boundary tests: a
 * state that sits exactly on the drift trigger has to sit there on both sides,
 * or the test would be measuring a rounding difference.
 */
import type { Address } from "viem";
import { VENUS_ALLOCATION_BSC_TESTNET } from "../src/venus/addresses.js";
import type {
  AllocationAccountState,
  AllocationMarketState,
  AllocationReader,
} from "../src/venus/reader.js";

export const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;

export const VUSDT = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as Address;
export const VUSDC = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7" as Address;
export const VBUSD = "0x08e0a5575de71037ae36abfafb516595fe68e5e4" as Address;

export const USDT = "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c" as Address;
export const USDC = "0x16227d60f7a0e586c66b005219dfc887d13c9531" as Address;
export const BUSD = "0x8301f2213c0eed49a7e28ae4c3e91722919b8b47" as Address;

/** 6-decimal underlying priced at $0.50, as on chain 97. */
export const USDT_PRICE_6DP = 5n * 10n ** 29n;
/** 6-decimal underlying priced at $1.00, as on chain 97. */
export const USDC_PRICE_6DP = 10n ** 30n;
/** 18-decimal underlying, as the testnet ResilientOracle actually reports it. */
export const BUSD_PRICE_18DP = 999_777_700_000_000_000n;

export const BLOCK = 125_929_412n;

/** No practical ceiling, which is what both live stablecoin markets carry. */
export const UNCAPPED = (1n << 256n) - 1n;

/** A fifth of a unit per vToken, the order the live markets sit at. */
export const EXCHANGE_RATE = 2n * 10n ** 14n;

export interface MarketFixture {
  readonly vToken: Address;
  readonly underlying: Address;
  readonly symbol: string;
  readonly underlyingDecimals: number;
  readonly priceMantissa: bigint;
  /** The account's own position, in underlying base units. Converted to vTokens here. */
  readonly supplied: bigint;
  /** Underlying sitting idle in the wallet, in base units. */
  readonly idle: bigint;
  readonly allowance?: bigint;
  /** Underlying the whole market holds. Sets `totalSupply`, and so the supply headroom. */
  readonly marketSupplied?: bigint;
  readonly supplyCapRaw?: bigint;
  readonly exchangeRateMantissa?: bigint;
  readonly isListed?: boolean;
  readonly mintPaused?: boolean;
  readonly reportedDecimals?: number | null;
  readonly implementation?: Address | null;
  readonly unreadableReason?: string;
}

export function market(fixture: MarketFixture): AllocationMarketState {
  const exchangeRate = fixture.exchangeRateMantissa ?? EXCHANGE_RATE;
  const marketSupplied = fixture.marketSupplied ?? 10_000_000_000n;

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
    exchangeRateMantissa: exchangeRate,
    totalSupplyVTokens: (marketSupplied * 10n ** 18n) / exchangeRate,
    priceMantissa: fixture.priceMantissa,
    vTokenBalance: (fixture.supplied * 10n ** 18n) / exchangeRate,
    walletBalance: fixture.idle,
    allowance: fixture.allowance ?? fixture.idle,
    implementation:
      fixture.implementation === undefined
        ? VENUS_ALLOCATION_BSC_TESTNET.vTokenImplementation
        : fixture.implementation,
    unreadableReason: fixture.unreadableReason,
  };
}

export interface SideFixture {
  /** Base units of the underlying already supplied into the market. */
  readonly supplied: bigint;
  /** Base units sitting idle in the wallet. */
  readonly idle: bigint;
  readonly allowance?: bigint;
  readonly mintPaused?: boolean;
  readonly supplyCapRaw?: bigint;
  readonly marketSupplied?: bigint;
}

export function usdtMarket(side: SideFixture): AllocationMarketState {
  return market({
    vToken: VUSDT,
    underlying: USDT,
    symbol: "USDT",
    underlyingDecimals: 6,
    priceMantissa: USDT_PRICE_6DP,
    ...side,
  });
}

export function usdcMarket(side: SideFixture): AllocationMarketState {
  return market({
    vToken: VUSDC,
    underlying: USDC,
    symbol: "USDC",
    underlyingDecimals: 6,
    priceMantissa: USDC_PRICE_6DP,
    ...side,
  });
}

/**
 * vBUSD as chain 97 actually holds it: listed, priced, and accepting nothing.
 *
 * It carries no target weight in either policy, so it can never be the market
 * the agent picks. It is here because idle BUSD is capital the published
 * allocation still has to account for, and because a listed market that rejects
 * every mint is the case an availability filter exists for.
 *
 * The idle balance defaults to zero. BUSD in the wallet is a real state with its
 * own test, but folding it into every fixture would silently move the portfolio
 * denominator that every other test's arithmetic rests on.
 */
export function retiredBusd(idle = 0n): AllocationMarketState {
  return market({
    vToken: VBUSD,
    underlying: BUSD,
    symbol: "BUSD",
    underlyingDecimals: 18,
    priceMantissa: BUSD_PRICE_18DP,
    supplied: 0n,
    idle,
    mintPaused: true,
    supplyCapRaw: 0n,
    marketSupplied: 1_000n * 10n ** 18n,
  });
}

export function state(markets: readonly AllocationMarketState[]): AllocationAccountState {
  return {
    chainId: VENUS_ALLOCATION_BSC_TESTNET.chainId,
    account: ACCOUNT,
    blockNumber: BLOCK,
    markets,
  };
}

/** The canonical three-market board: USDT, USDC, and the retired BUSD market. */
export function position(usdt: SideFixture, usdc: SideFixture, busdIdle = 0n): AllocationAccountState {
  return state([usdtMarket(usdt), usdcMarket(usdc), retiredBusd(busdIdle)]);
}

/**
 * A portfolio well outside either band: $700 USDT supplied, $100 USDC supplied,
 * $200 USDC idle.
 *
 * The total is $1000, so each 5000 bps target is $500. USDC is $400 short and
 * USDT is $200 over, which is 4000 bps of drift — far outside the narrow band
 * and the wide one alike, so both agents act and the top-up is sized by the
 * $200 of idle USDC rather than by the gap.
 */
export function driftedBoard(): AllocationAccountState {
  return position(
    { supplied: 1_400_000_000n, idle: 0n },
    { supplied: 100_000_000n, idle: 200_000_000n },
  );
}

/**
 * A portfolio sitting exactly on the 100 bps trigger.
 *
 * 990 USDT supplied at fifty cents is $495; 490 USDC supplied is $490; 15 USDC
 * idle is $15. The total is $1000, each target is $500, and USDC is $10 short —
 * which is exactly 100 bps of the portfolio. The narrow band's `>=` fires here
 * and the wide band's 600 bps does not, so the same board separates the pair on
 * the decision itself rather than on the size.
 *
 * USDT is $5 short at the same time, which is deliberate: it keeps USDC the
 * most under-weight market by a margin the ranking has to get right, rather
 * than by being the only candidate.
 */
export function boundaryBoard(): AllocationAccountState {
  return position(
    { supplied: 990_000_000n, idle: 0n },
    { supplied: 490_000_000n, idle: 15_000_000n },
  );
}

/**
 * One base unit of USDC further into the band than `boundaryBoard`.
 *
 * A whole underlying unit rather than a single vToken unit, because a vToken
 * unit is below the resolution of the agent's two-step valuation — it floors at
 * the underlying — while the reference model's single division keeps it. The
 * two implementations must flip at the same state, so the step between the two
 * fixtures has to be one both of them can see.
 */
export function insideBandBoard(): AllocationAccountState {
  return position(
    { supplied: 990_000_000n, idle: 0n },
    { supplied: 490_000_001n, idle: 15_000_000n },
  );
}

/**
 * Out of band with nothing idle to correct it: $900 USDT, $100 USDC, no cash.
 *
 * The only way back to parity is to take $400 out of the USDT market, which
 * needs `redeemUnderlying(uint256)`. This is the state the whole limitation is
 * about, and the agent has to name the function it does not have rather than
 * report a portfolio it did not fix.
 */
export function starvedBoard(): AllocationAccountState {
  return position(
    { supplied: 1_800_000_000n, idle: 0n },
    { supplied: 100_000_000n, idle: 0n },
  );
}

export function fixedReader(accountState: AllocationAccountState): AllocationReader {
  return { readAccountState: () => Promise.resolve(accountState) };
}

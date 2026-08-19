/**
 * Fixed Venus positions.
 *
 * Scales are the real ones read off chain 97: the mock USDT is 6 decimals and
 * the oracle prices it at $0.50, which makes `5e29` the correct price mantissa
 * (`1e(36-6)` scaling). Rounding those to a friendlier $1.00 at 18 decimals
 * would delete the exact trap these tests exist to catch.
 */
import type { Address } from "viem";
import { VENUS_BSC_TESTNET } from "../src/venus/addresses.js";
import type { VenusAccountState, VenusMarketState, VenusReader } from "../src/venus/reader.js";
import { MANTISSA } from "../src/venus/health.js";

export const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
export const VCOLLATERAL = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7" as Address;

/** 6-decimal underlying priced at $0.50, as on chain 97. */
export const USDT_PRICE_6DP = 5n * 10n ** 29n;
/** The same dollar price for an 18-decimal underlying, as on chain 56. */
export const USDT_PRICE_18DP = 5n * 10n ** 17n;
/** vUSDC on chain 97: 6 decimals, priced at $1.00. */
export const USDC_PRICE_6DP = 10n ** 30n;

export function usd(amount: number): bigint {
  return (BigInt(Math.round(amount * 1_000_000)) * MANTISSA) / 1_000_000n;
}

export interface MarketFixture {
  readonly vToken: Address;
  readonly collateralUsd: number;
  readonly liquidationThresholdMantissa: bigint;
  readonly borrowBalance: bigint;
  readonly priceMantissa: bigint;
  readonly underlyingDecimals: number;
}

export function market(fixture: MarketFixture): VenusMarketState {
  const collateralUsd = usd(fixture.collateralUsd);
  return {
    vToken: fixture.vToken,
    isListed: true,
    collateralFactorMantissa: (75n * MANTISSA) / 100n,
    liquidationThresholdMantissa: fixture.liquidationThresholdMantissa,
    priceMantissa: fixture.priceMantissa,
    underlyingDecimals: fixture.underlyingDecimals,
    vTokenBalance: 0n,
    exchangeRateMantissa: MANTISSA,
    borrowBalance: fixture.borrowBalance,
    liquidationWeightedCollateralUsd: (collateralUsd * fixture.liquidationThresholdMantissa) / MANTISSA,
    borrowUsd: (fixture.borrowBalance * fixture.priceMantissa) / MANTISSA,
  };
}

export interface AccountFixture {
  readonly markets: readonly VenusMarketState[];
  readonly liquidityUsd?: bigint;
  readonly shortfallUsd?: bigint;
  readonly vaiDebtUsd?: bigint;
  readonly vTokenImplementation?: Address;
}

/**
 * Build an account whose `getAccountLiquidity` agrees with its markets.
 *
 * Derived rather than stated so a fixture cannot drift into an inconsistency
 * the reconstruction check would flag for reasons unrelated to the test.
 */
export function account(fixture: AccountFixture): VenusAccountState {
  const collateral = fixture.markets.reduce((sum, m) => sum + m.liquidationWeightedCollateralUsd, 0n);
  const vaiDebtUsd = fixture.vaiDebtUsd ?? 0n;
  const borrows = fixture.markets.reduce((sum, m) => sum + m.borrowUsd, 0n) + vaiDebtUsd;
  const difference = collateral - borrows;

  return {
    chainId: VENUS_BSC_TESTNET.chainId,
    account: ACCOUNT,
    blockNumber: 125_582_704n,
    vTokenImplementation: fixture.vTokenImplementation ?? VENUS_BSC_TESTNET.vTokenImplementation,
    liquidityUsd: fixture.liquidityUsd ?? (difference > 0n ? difference : 0n),
    shortfallUsd: fixture.shortfallUsd ?? (difference < 0n ? -difference : 0n),
    vaiDebtUsd,
    markets: fixture.markets,
    targetMarket: fixture.markets.find((m) => m.vToken === VENUS_BSC_TESTNET.vToken),
  };
}

/**
 * A position whose health factor is `collateral / borrow`.
 *
 * Collateral sits in vUSDC and the debt in vUSDT, which is the shape the agent
 * is authorised for: it may repay USDT and nothing else.
 *
 * Exported rather than kept local to this package's tests because the sibling
 * agent deliberates over the same boards. Two agents compared on boards built
 * by two builders are being compared on the builders as much as on themselves,
 * and the claim the pair rests on is that one board produces two answers.
 */
export function position(collateralUsd: number, borrowUsdt: bigint): VenusAccountState {
  return account({
    markets: [
      market({
        vToken: VCOLLATERAL,
        collateralUsd,
        liquidationThresholdMantissa: MANTISSA,
        borrowBalance: 0n,
        priceMantissa: USDC_PRICE_6DP,
        underlyingDecimals: 6,
      }),
      market({
        vToken: VENUS_BSC_TESTNET.vToken,
        collateralUsd: 0,
        liquidationThresholdMantissa: (80n * MANTISSA) / 100n,
        borrowBalance: borrowUsdt,
        priceMantissa: USDT_PRICE_6DP,
        underlyingDecimals: 6,
      }),
    ],
  });
}

export function fixedReader(state: VenusAccountState): VenusReader {
  return { readAccountState: () => Promise.resolve(state) };
}

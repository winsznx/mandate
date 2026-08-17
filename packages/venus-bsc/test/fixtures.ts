/**
 * The frozen reading, and the arithmetic the regressions freeze around it.
 *
 * The fixture is a real BSC testnet account read at a real block. It is
 * committed rather than fetched because its block can no longer be forked: a
 * capability probe of `bsc-testnet-rpc.publicnode.com` measured anvil's fork
 * window at 9,375 blocks, and the fixture is millions behind that.
 *
 * The scale arithmetic below is deliberately reimplemented here rather than
 * imported from `reference/health-factor`. Two reasons, and the second is the
 * important one. The dependency would be circular — the reference model already
 * depends on this package. And a regression test that computes its expected
 * value with the implementation it is testing cannot fail: it would re-derive
 * whatever the implementation currently does and assert that it equals itself.
 * These functions are the independent second opinion, written from the protocol
 * definition, and the numbers they produce are pinned as literals below.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import type { RawMarketObservation, RawVenusObservation } from "../src/observation.js";

export interface FrozenFixture {
  readonly invariant: string;
  readonly provenance: {
    readonly chainId: number;
    readonly account: string;
    readonly blockNumber: string;
    readonly blockHash: string;
  };
  readonly observation: RawVenusObservation;
  readonly brokenView: { readonly vaiDebtMissed: string; readonly principalUnderstatement: string };
  readonly hasDebtOutsideEnteredMarkets: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "venus-accounting-001.json"), "utf8"),
) as FrozenFixture;

export const FROZEN: RawVenusObservation = FIXTURE.observation;

/** The account's only collateral market: the 6-decimal Venus mock USDC. */
export const VUSDC: Address = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7";

/** Fixed-point one. Thresholds, exchange rates and USD figures all live here. */
export const MANTISSA = 10n ** 18n;

export function marketAt(observation: RawVenusObservation, vToken: Address): RawMarketObservation {
  const market = observation.markets.find((candidate) => candidate.vToken === vToken);
  if (market === undefined) throw new Error(`fixture has no market ${vToken}`);
  return market;
}

/** `getUnderlyingPrice` returns this scale, which is why decimals cannot be guessed. */
export function oracleScaleFor(decimals: number): bigint {
  return 10n ** BigInt(36 - decimals);
}

/**
 * USD at 1e18 for a vToken balance, priced without flooring first.
 *
 * `balance * rate` carries 1e18 of exchange-rate scale on top of the underlying
 * amount, and `price` carries `1e(36 - decimals)`, so one division by 1e36
 * lands on 1e18 with nothing discarded on the way.
 */
export function vTokenToUsdUnfloored(
  vTokenBalance: bigint,
  exchangeRateMantissa: bigint,
  priceMantissa: bigint,
): bigint {
  return (vTokenBalance * exchangeRateMantissa * priceMantissa) / (MANTISSA * MANTISSA);
}

/**
 * The same value via a materialised underlying amount, which is the wrong order.
 *
 * Kept so VENUS-ACCOUNTING-003 can assert what the floored route produces
 * rather than merely asserting that the right route is right.
 */
export function vTokenToUsdFlooredFirst(
  vTokenBalance: bigint,
  exchangeRateMantissa: bigint,
  priceMantissa: bigint,
): bigint {
  const underlying = (vTokenBalance * exchangeRateMantissa) / MANTISSA;
  return (underlying * priceMantissa) / MANTISSA;
}

export function applyWeight(usdMantissa: bigint, weightMantissa: bigint): bigint {
  return (usdMantissa * weightMantissa) / MANTISSA;
}

/** A 1e18 ratio as a decimal string, truncated rather than rounded. */
export function formatMantissa(value: bigint, places = 6): string {
  const whole = value / MANTISSA;
  const fraction = (value % MANTISSA).toString(10).padStart(18, "0").slice(0, places);
  return `${whole}.${fraction}`;
}

export function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** Repository root, derived from this file rather than from a checked-in absolute path. */
export const REPO_ROOT = join(here, "..", "..", "..");

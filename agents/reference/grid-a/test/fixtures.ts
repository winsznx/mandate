/**
 * Fixed stableswap pool states.
 *
 * The numbers are the ones read off chain 97 at block 125936215 rather than
 * friendlier round ones. The pool holds 11000.088866653130611994 wstETH against
 * 10999.897033824441897510 mstETH, its stored rates are
 * 1.162099789246041346 and 1.001934555854347587, and its own `get_dy(0, 1, 1e18)`
 * is 1158021437469978502. Those rates are the whole reason the fixture is not
 * symmetric: both coins are liquid-staking tokens whose redemption values have
 * drifted 16% apart, and a fixture that pretended they were pegged at 1:1 would
 * delete the exact trap the ladder exists to avoid.
 *
 * At those live readings the pool sits 16 basis points below fair, which is
 * inside the first rung of both agents in this category. That is a legitimate
 * hold and a useless test, so the helpers here drive the price directly.
 */
import type { Address, Hex } from "viem";
import { STABLESWAP_BSC_TESTNET } from "../src/pool/addresses.js";
import type { CoinState, PoolReader, PoolState, TrancheQuote } from "../src/pool/reader.js";

export const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
export const POOL = STABLESWAP_BSC_TESTNET.pool;

export const WSTETH = "0x5dbb9d2d526ab0c5f8829ad4951fb2dd93e0b62f" as Address;
export const MSTETH = "0xc97642f407caea4f31464ab005276e5fb215c6fa" as Address;

/** `stored_rates()` as chain 97 reports them. Their ratio is the ladder's centre. */
export const STORED_RATE_0 = 1_162_099_789_246_041_346n;
export const STORED_RATE_1 = 1_001_934_555_854_347_587n;

export const POOL_BALANCE_0 = 11_000_088_866_653_130_611_994n;
export const POOL_BALANCE_1 = 10_999_897_033_824_441_897_510n;

export const VIRTUAL_PRICE = 1_000_000_004_561_277_297n;

export const BLOCK = 125_936_215n;
export const ONE = 10n ** 18n;

/** The price the stored rates imply, which is where the ladder centres. */
export const FAIR_RATE = (STORED_RATE_0 * ONE) / STORED_RATE_1;

/**
 * A probe quote that lands on exactly `deviationBps` off fair.
 *
 * Solved rather than approximated. The deviation is an integer basis-point
 * figure computed by a truncating division, so the naive
 * `fair + fair * dev / 10000` misses the value it was aiming at by one in most
 * cases — and a test about a rung boundary that lands one basis point off the
 * boundary is testing the wrong side of it.
 */
export function probeDyForDeviation(deviationBps: number): bigint {
  const target = BigInt(deviationBps);
  let candidate = FAIR_RATE + (FAIR_RATE * target) / 10_000n;
  const measured = (value: bigint): bigint => ((value - FAIR_RATE) * 10_000n) / FAIR_RATE;
  // The naive starting point truncates toward zero, so it always lands on the
  // side of the target nearer to fair. Walking away from fair is therefore the
  // direction that closes the gap, whichever sign the target has.
  const step = target < 0n ? -1n : 1n;
  for (let attempt = 0; attempt < 4_096 && measured(candidate) !== target; attempt += 1) {
    candidate += step;
  }
  if (measured(candidate) !== target) {
    throw new Error(`no probe quote lands on ${deviationBps} bps`);
  }
  return candidate;
}

export interface CoinFixture {
  readonly walletBalance: bigint;
  readonly allowance?: bigint;
  readonly reportedDecimals?: number | null;
  readonly storedRate?: bigint | null;
  readonly poolBalance?: bigint | null;
}

function coin(
  index: number,
  token: Address,
  symbol: string,
  defaultRate: bigint,
  defaultPoolBalance: bigint,
  fixture: CoinFixture,
): CoinState {
  return {
    index,
    token,
    symbol,
    decimals: 18,
    reportedDecimals: fixture.reportedDecimals === undefined ? 18 : fixture.reportedDecimals,
    poolBalance: fixture.poolBalance === undefined ? defaultPoolBalance : fixture.poolBalance,
    storedRate: fixture.storedRate === undefined ? defaultRate : fixture.storedRate,
    walletBalance: fixture.walletBalance,
    allowance: fixture.allowance ?? fixture.walletBalance,
  };
}

export interface PoolFixture {
  /** Where the price sits relative to fair. Negative means coin 0 is cheap. */
  readonly deviationBps: number;
  readonly coin0: CoinFixture;
  readonly coin1: CoinFixture;
  readonly trancheSize?: bigint;
  readonly codeHash?: Hex | null;
  readonly probeDy?: bigint | null;
  readonly unreadableReason?: string;
  /** Suppress the tranche quote in one direction, to exercise the refusal path. */
  readonly suppressTrancheQuotes?: boolean;
}

/**
 * A pool state at a chosen distance from fair.
 *
 * The tranche quotes are derived from the same rate the probe implies, so a
 * fixture cannot drift into a state where the probe says one thing and the
 * trade quote says another for no stated reason.
 */
export function poolState(fixture: PoolFixture): PoolState {
  const probeDy = fixture.probeDy === undefined ? probeDyForDeviation(fixture.deviationBps) : fixture.probeDy;
  const tranche = fixture.trancheSize ?? ONE;
  const rate = probeDy ?? FAIR_RATE;

  const quotes: TrancheQuote[] = fixture.suppressTrancheQuotes === true
    ? []
    : [
        { fromIndex: 0, toIndex: 1, dx: tranche, dy: (tranche * rate) / ONE },
        // The reverse leg at the inverse rate, so both directions describe one
        // price rather than two unrelated ones.
        { fromIndex: 1, toIndex: 0, dx: tranche, dy: (tranche * ONE) / rate },
      ];

  return {
    chainId: 97,
    pool: POOL,
    blockNumber: BLOCK,
    account: ACCOUNT,
    codeHash: fixture.codeHash === undefined ? null : fixture.codeHash,
    virtualPrice: VIRTUAL_PRICE,
    coins: [
      coin(0, WSTETH, "wstETH", STORED_RATE_0, POOL_BALANCE_0, fixture.coin0),
      coin(1, MSTETH, "mstETH", STORED_RATE_1, POOL_BALANCE_1, fixture.coin1),
    ],
    probeDy,
    trancheQuotes: quotes,
    unreadableReason: fixture.unreadableReason,
  };
}

/**
 * Balances that put the account at a given inventory share of coin 0.
 *
 * Shares are measured on rate-adjusted balances, so the two raw balances that
 * produce a 5000 bps share are not equal. Deriving them here keeps every test
 * that is not about the rate adjustment from having to restate it.
 */
export function balancesForShare(shareBps: number, totalUnits: bigint): {
  readonly coin0: bigint;
  readonly coin1: bigint;
} {
  const units0 = (totalUnits * BigInt(shareBps)) / 10_000n;
  const units1 = totalUnits - units0;
  return {
    coin0: (units0 * ONE) / STORED_RATE_0,
    coin1: (units1 * ONE) / STORED_RATE_1,
  };
}

export function fixedReader(state: PoolState): PoolReader {
  return { readPoolState: () => Promise.resolve(state) };
}

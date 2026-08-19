/**
 * Fixed stableswap observations, in the raw form the adapter emits.
 *
 * Every default is a reading taken off chain 97 at block 125936215: the pool
 * holds 11000.088866653130611994 wstETH against 10999.897033824441897510
 * mstETH, `A()` is 100, `fee()` is 1000000, `offpeg_fee_multiplier()` is
 * 20000000000, and the stored rates are 1.162099789246041346 and
 * 1.001934555854347587. The pool's own `get_dy(0, 1, 1e18)` at that block is
 * 1158021437469978502, which is what the reconstruction is checked against.
 *
 * The rates are the reason the fixture is not symmetric. Both coins are liquid-
 * staking tokens whose redemption values have drifted 16% apart, and a fixture
 * that pretended they were pegged at 1:1 would delete the exact trap the model
 * exists to avoid: an invariant solved on raw balances prices a badly
 * imbalanced pool as a balanced one.
 *
 * Prices are moved by skewing the pool's own balances rather than by injecting
 * a rate, because that is the only lever the real pool has. This model derives
 * its price from the invariant, so a fixture that set a price directly would be
 * testing a code path the model does not have.
 */
import type { RawStableswapObservation } from "@mandate/stableswap-bsc";
import type { Address, Hex } from "viem";
import type { ReferenceGridPolicy } from "../src/model.js";

export const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
export const POOL = "0x157b06e4d9501071a401234f117edee913217833" as Address;
export const WSTETH = "0x5dbb9d2d526ab0c5f8829ad4951fb2dd93e0b62f" as Address;
export const MSTETH = "0xc97642f407caea4f31464ab005276e5fb215c6fa" as Address;

export const EXCHANGE_SELECTOR = "0x3df02124" as Hex;

export const BLOCK = "125936215";
export const BLOCK_HASH = `0x${"ab".repeat(32)}` as Hex;

export const ONE = 10n ** 18n;

/** Readings frozen off chain 97 at block 125936215. */
export const CHAIN = {
  balance0: 11_000_088_866_653_130_611_994n,
  balance1: 10_999_897_033_824_441_897_510n,
  storedRate0: 1_162_099_789_246_041_346n,
  storedRate1: 1_001_934_555_854_347_587n,
  amplification: 100n,
  feeBase: 1_000_000n,
  offpegFeeMultiplier: 20_000_000_000n,
  virtualPrice: 1_000_000_004_561_277_297n,
  /** `get_dy(0, 1, 1e18)` as the pool itself reported it. */
  poolQuote0To1: 1_158_021_437_469_978_502n,
  /** `get_dy(1, 0, 1e18)` as the pool itself reported it. */
  poolQuote1To0: 863_367_093_084_179_311n,
} as const;

export const AMPLIFICATION_PRECISION = 100n;

/** The price the stored rates imply, which is where the ladder centres. */
export const FAIR_RATE = (CHAIN.storedRate0 * ONE) / CHAIN.storedRate1;

/**
 * The policy the tests run against.
 *
 * The same numbers the Tight Grid publishes, restated here rather than
 * imported. The duplication is deliberate: a test that read the agent's
 * constants would pass whenever the agent and this model agreed with each
 * other, including when both were wrong.
 */
export const TEST_POLICY: ReferenceGridPolicy = {
  policyId: "tight-grid",
  spacingBps: 25,
  levels: 8,
  inventoryStepBps: 250,
  trancheRawUnits: ONE,
  maxSlippageBps: 30,
  probeSizeRawUnits: ONE,
  amountToleranceBps: 50,
};

/** The Wide Grid's ladder, for the tests that show the two diverge. */
export const WIDE_POLICY: ReferenceGridPolicy = {
  ...TEST_POLICY,
  policyId: "wide-grid",
  spacingBps: 100,
  levels: 4,
  inventoryStepBps: 500,
  maxSlippageBps: 50,
};

export interface ObservationFixture {
  /** Multiplies the pool's coin-0 balance. Above 1 makes coin 0 abundant and cheap. */
  readonly skewNumerator?: bigint;
  readonly skewDenominator?: bigint;
  readonly walletBalance0?: bigint;
  readonly walletBalance1?: bigint;
  readonly allowance0?: bigint;
  readonly allowance1?: bigint;
  readonly reportedDecimals1?: number | null;
  /** Overrides applied to the top-level observation, for the fail-closed paths. */
  readonly overrides?: Partial<RawStableswapObservation>;
  /** Overrides applied to coin 0, for the fail-closed paths. */
  readonly coin0Overrides?: Partial<RawStableswapObservation["coins"][number]>;
}

export function observation(fixture: ObservationFixture = {}): RawStableswapObservation {
  const numerator = fixture.skewNumerator ?? 100n;
  const denominator = fixture.skewDenominator ?? 100n;
  const balance0 = (CHAIN.balance0 * numerator) / denominator;

  return {
    schemaVersion: "mandate.stableswap-observation/1",
    chainId: 97,
    account: ACCOUNT,
    blockNumber: BLOCK,
    blockHash: BLOCK_HASH,
    pool: POOL,
    amplification: CHAIN.amplification.toString(10),
    feeBase: CHAIN.feeBase.toString(10),
    offpegFeeMultiplier: CHAIN.offpegFeeMultiplier.toString(10),
    virtualPrice: CHAIN.virtualPrice.toString(10),
    coins: [
      {
        index: 0,
        token: WSTETH,
        symbol: "wstETH",
        decimals: 18,
        reportedDecimals: 18,
        poolBalance: balance0.toString(10),
        storedRate: CHAIN.storedRate0.toString(10),
        walletBalance: (fixture.walletBalance0 ?? 0n).toString(10),
        walletAllowance: (fixture.allowance0 ?? ONE * 100n).toString(10),
        ...fixture.coin0Overrides,
      },
      {
        index: 1,
        token: MSTETH,
        symbol: "mstETH",
        decimals: 18,
        reportedDecimals:
          fixture.reportedDecimals1 === undefined ? 18 : fixture.reportedDecimals1,
        poolBalance: CHAIN.balance1.toString(10),
        storedRate: CHAIN.storedRate1.toString(10),
        walletBalance: (fixture.walletBalance1 ?? 0n).toString(10),
        walletAllowance: (fixture.allowance1 ?? ONE * 100n).toString(10),
      },
    ],
    // Recorded exactly as the pool answered at the unskewed block. A skewed
    // fixture leaves it in place on purpose, so the reconstruction's
    // disagreement with a stale quote stays visible rather than being tidied
    // into agreement.
    poolQuotes: [
      { fromIndex: 0, toIndex: 1, dx: ONE.toString(10), dy: CHAIN.poolQuote0To1.toString(10) },
      { fromIndex: 1, toIndex: 0, dx: ONE.toString(10), dy: CHAIN.poolQuote1To0.toString(10) },
    ],
    ...fixture.overrides,
  };
}

/**
 * Wallet balances that put the account at a given inventory share of coin 0.
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
    coin0: (units0 * ONE) / CHAIN.storedRate0,
    coin1: (units1 * ONE) / CHAIN.storedRate1,
  };
}

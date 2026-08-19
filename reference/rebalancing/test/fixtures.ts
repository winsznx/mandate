/**
 * Fixed Venus portfolio observations, in the raw form the adapter emits.
 *
 * The boards are numerically the same ones the agent's own suite runs on, and
 * they are restated here rather than imported. That duplication is the whole
 * arrangement: a fixture read out of the agent's package would make this
 * model's tests pass exactly when the agent and the model agreed with each
 * other, including when both were wrong.
 *
 * Scales are the ones read off chain 97: both stablecoin mocks are 6 decimals,
 * USDT prices at `5e29` (fifty cents at the `1e(36 - decimals)` scaling), USDC
 * at `1e30` (a dollar), and BUSD at `999777700000000000`, which is the live
 * 18-decimal reading and not quite a dollar. Two markets with the same decimals
 * and different prices is the pairing that catches a model measuring weights in
 * token units: 1000 USDT and 1000 USDC look balanced and are two-thirds USDC.
 *
 * The balance sheet and the vToken supply are kept consistent with each other
 * on purpose. This model reads `cash + borrows - reserves` and reports its
 * disagreement with `totalSupply * exchangeRate` as drift, so a fixture that
 * let them drift for no reason would put noise into every test that is not
 * about drift. The tests that are about drift set it deliberately.
 *
 * Positions are stated in underlying base units and converted to vToken units
 * here. At the fixture exchange rate of `2e14` one base unit is exactly 5000
 * vToken units, so every position is representable without a remainder and this
 * model's single-division valuation lands on the same figure the agent's
 * two-step one does. The boundary tests depend on that: a state that sits
 * exactly on the drift trigger has to sit there on both sides.
 */
import type { RawSupplyMarketObservation, RawSupplyObservation } from "@mandate/venus-bsc";
import type { Address, Hex } from "viem";
import type { ReferenceRebalancingPolicy } from "../src/model.js";

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
export const BUSD_PRICE_18DP = 999_777_700_000_000_000n;

export const MINT_SELECTOR = "0xa0712d68" as Hex;

export const BLOCK = "125929412";
export const BLOCK_HASH = `0x${"ab".repeat(32)}` as Hex;

export const UNCAPPED = ((1n << 256n) - 1n).toString(10);

/** The exchange rate the live stablecoin markets sit at, to the order of magnitude. */
export const EXCHANGE_RATE = 2n * 10n ** 14n;

/**
 * The narrow band the reference agent publishes, restated rather than imported.
 *
 * A test that read the agent's constants would pass whenever the agent and this
 * model agreed with each other, which is exactly the failure the two-implementation
 * arrangement exists to catch.
 */
export const TEST_POLICY: ReferenceRebalancingPolicy = {
  policyId: "narrow-band-allocator",
  targets: [
    { vToken: VUSDT, weightBps: 5_000 },
    { vToken: VUSDC, weightBps: 5_000 },
  ],
  driftTriggerBps: 100,
  minRebalanceUsdMantissa: 10n * 10n ** 18n,
  amountToleranceBps: 50,
};

/** The wide-band sibling's policy, for the tests that separate the pair. */
export const WIDE_POLICY: ReferenceRebalancingPolicy = {
  ...TEST_POLICY,
  policyId: "wide-band-allocator",
  driftTriggerBps: 600,
};

export interface MarketFixture {
  readonly vToken: Address;
  readonly underlying: Address;
  readonly symbol: string;
  readonly underlyingDecimals: number;
  readonly priceMantissa: bigint;
  /** The account's own position, in underlying base units. */
  readonly supplied: bigint;
  /** Underlying sitting idle in the wallet, in base units. */
  readonly idle: bigint;
  readonly allowance?: bigint;
  /** Underlying the whole market holds. Split across cash and borrows by the helper. */
  readonly marketSupplied?: bigint;
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
  const marketSupplied = fixture.marketSupplied ?? 10_000_000_000n;
  const borrows = marketSupplied / 4n;
  const reserves = 0n;
  const cash = marketSupplied - borrows;
  const totalSupply =
    fixture.totalSupplyVTokens ?? (marketSupplied * 10n ** 18n) / EXCHANGE_RATE;

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
    // Read but never used by this model: an allocation is held by weight, not
    // by yield. Present because the shared observation carries it.
    supplyRatePerBlockMantissa: "0",
    exchangeRateMantissa: EXCHANGE_RATE.toString(10),
    totalSupplyVTokens: totalSupply.toString(10),
    cashRaw: cash.toString(10),
    totalBorrowsRaw: borrows.toString(10),
    totalReservesRaw: reserves.toString(10),
    vTokenBalance: ((fixture.supplied * 10n ** 18n) / EXCHANGE_RATE).toString(10),
    walletUnderlyingBalance: fixture.idle.toString(10),
    walletAllowance: (fixture.allowance ?? fixture.idle).toString(10),
    priceMantissa: fixture.priceMantissa.toString(10),
    implementation: IMPLEMENTATION,
    ...fixture.overrides,
  };
}

export interface SideFixture {
  readonly supplied: bigint;
  readonly idle: bigint;
  readonly allowance?: bigint;
  readonly mintPaused?: boolean | null;
  readonly supplyCapRaw?: string;
  readonly marketSupplied?: bigint;
}

export function usdtMarket(side: SideFixture): RawSupplyMarketObservation {
  return market({
    vToken: VUSDT,
    underlying: USDT,
    symbol: "USDT",
    underlyingDecimals: 6,
    priceMantissa: USDT_PRICE_6DP,
    ...side,
  });
}

export function usdcMarket(side: SideFixture): RawSupplyMarketObservation {
  return market({
    vToken: VUSDC,
    underlying: USDC,
    symbol: "USDC",
    underlyingDecimals: 6,
    priceMantissa: USDC_PRICE_6DP,
    ...side,
  });
}

/** vBUSD as chain 97 holds it: listed, priced, mint paused, supply cap zero. */
export function retiredBusd(idle = 0n): RawSupplyMarketObservation {
  return market({
    vToken: VBUSD,
    underlying: BUSD,
    symbol: "BUSD",
    underlyingDecimals: 18,
    priceMantissa: BUSD_PRICE_18DP,
    supplied: 0n,
    idle,
    mintPaused: true,
    supplyCapRaw: "0",
    marketSupplied: 1_000n * 10n ** 18n,
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

/** The canonical three-market board: USDT, USDC, and the retired BUSD market. */
export function position(usdt: SideFixture, usdc: SideFixture, busdIdle = 0n): RawSupplyObservation {
  return observation([usdtMarket(usdt), usdcMarket(usdc), retiredBusd(busdIdle)]);
}

/**
 * A portfolio well outside either band: $700 USDT supplied, $100 USDC supplied,
 * $200 USDC idle. Total $1000, each target $500, USDC $400 short.
 */
export function driftedBoard(): RawSupplyObservation {
  return position(
    { supplied: 1_400_000_000n, idle: 0n },
    { supplied: 100_000_000n, idle: 200_000_000n },
  );
}

/**
 * A portfolio sitting exactly on the 100 bps trigger.
 *
 * $495 USDT supplied, $490 USDC supplied, $15 USDC idle. The total is $1000,
 * each target is $500, and USDC is $10 short — exactly 100 bps of the
 * portfolio. USDT is $5 short at the same time, so USDC has to win the ranking
 * rather than be the only candidate.
 */
export function boundaryBoard(): RawSupplyObservation {
  return position(
    { supplied: 990_000_000n, idle: 0n },
    { supplied: 490_000_000n, idle: 15_000_000n },
  );
}

/**
 * One base unit of USDC further into the band than `boundaryBoard`.
 *
 * A whole underlying unit rather than a single vToken unit, because a vToken
 * unit is below the resolution of the agent's two-step valuation while this
 * model's single division keeps it. The two implementations have to flip at the
 * same state, so the step between the two fixtures is one both can see.
 */
export function insideBandBoard(): RawSupplyObservation {
  return position(
    { supplied: 990_000_000n, idle: 0n },
    { supplied: 490_000_001n, idle: 15_000_000n },
  );
}

/**
 * Out of band with nothing idle to correct it: $900 USDT, $100 USDC, no cash.
 *
 * The only way back to parity is to take $400 out of the USDT market, which
 * needs `redeemUnderlying(uint256)`. This is the state the category's whole
 * limitation is about.
 */
export function starvedBoard(): RawSupplyObservation {
  return position(
    { supplied: 1_800_000_000n, idle: 0n },
    { supplied: 100_000_000n, idle: 0n },
  );
}

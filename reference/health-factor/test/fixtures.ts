/**
 * Observations to reason about.
 *
 * The frozen one is real: a BSC testnet account read at a real block, committed
 * because its original block can no longer be re-fetched from a public RPC.
 * The synthetic ones are built by editing that shape rather than by inventing a
 * new one, so a scenario that drifts away from what the chain actually returns
 * stops compiling.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import type { RawMarketObservation, RawVenusObservation } from "@mandate/venus-bsc";
import { MANTISSA } from "../src/scale.js";
import type { ReferencePolicy } from "../src/model.js";

interface FrozenFixture {
  readonly invariant: string;
  readonly observation: RawVenusObservation;
}

const frozen = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../packages/venus-bsc/fixtures/venus-accounting-001.json", import.meta.url)),
    "utf8",
  ),
) as FrozenFixture;

/** VENUS-ACCOUNTING-001: VAI debt, no vToken borrow, true health factor 2.505. */
export const FROZEN_OBSERVATION: RawVenusObservation = frozen.observation;

export const VUSDT: Address = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a";
export const VUSDC: Address = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7";
export const REPAY_BORROW_SELECTOR = "0x0e752702" as const;

/** The Conservative Guardian's published parameters, restated as trial input. */
export const TEST_POLICY: ReferencePolicy = {
  policyId: "conservative-guardian",
  interventionThresholdMantissa: (130n * MANTISSA) / 100n,
  targetHealthFactorMantissa: (135n * MANTISSA) / 100n,
  minimumRepayUsdMantissa: MANTISSA,
  amountToleranceBps: 50,
};

function marketAt(observation: RawVenusObservation, vToken: Address): RawMarketObservation {
  const market = observation.markets.find((candidate) => candidate.vToken === vToken);
  if (market === undefined) throw new Error(`fixture has no market ${vToken}`);
  return market;
}

export interface PositionOverrides {
  /** Raw underlying units of debt in vUSDT, the actionable market. */
  readonly usdtBorrow?: bigint;
  /** Raw vToken units of vUSDC collateral. */
  readonly usdcCollateral?: bigint;
  /** Raw VAI owed, principal plus accrued interest. */
  readonly vaiOwed?: bigint;
  /** Drop the oracle price on a market the account has a balance in. */
  readonly unpriceMarket?: Address;
}

/**
 * The frozen observation with a position edited onto it.
 *
 * `accountLiquidity` is left as the chain reported it for the frozen position
 * and is therefore stale on an edited one. That is deliberate: the reference
 * model must never consult it for an answer, so a test whose result changes
 * when it goes stale has caught the model reading it.
 */
export function positionWith(overrides: PositionOverrides): RawVenusObservation {
  const usdc = marketAt(FROZEN_OBSERVATION, VUSDC);
  const usdt = marketAt(FROZEN_OBSERVATION, VUSDT);

  const markets = FROZEN_OBSERVATION.markets.map((market): RawMarketObservation => {
    let next = market;
    if (market.vToken === VUSDC && overrides.usdcCollateral !== undefined) {
      next = { ...next, vTokenBalance: overrides.usdcCollateral.toString(10) };
    }
    if (market.vToken === VUSDT && overrides.usdtBorrow !== undefined) {
      next = { ...next, borrowBalance: overrides.usdtBorrow.toString(10) };
    }
    if (market.vToken === overrides.unpriceMarket) {
      next = {
        ...next,
        priceMantissa: null,
        priceUnavailableReason: "invalid resilient oracle price",
      };
    }
    return next;
  });

  return {
    ...FROZEN_OBSERVATION,
    markets,
    vai: {
      ...FROZEN_OBSERVATION.vai,
      repayAmount: (overrides.vaiOwed ?? BigInt(FROZEN_OBSERVATION.vai.repayAmount)).toString(10),
    },
  };
}

/** The exposure figures the frozen fixture reconstructs to, computed once by hand. */
export const FROZEN_EXPECTATIONS = {
  collateralVToken: BigInt(marketAt(FROZEN_OBSERVATION, VUSDC).vTokenBalance ?? "0"),
  vaiOwed: BigInt(FROZEN_OBSERVATION.vai.repayAmount),
  protocolLiquidity: BigInt(FROZEN_OBSERVATION.accountLiquidity.liquidity),
} as const;

export { usdtMarketOf };

function usdtMarketOf(observation: RawVenusObservation): RawMarketObservation {
  return marketAt(observation, VUSDT);
}

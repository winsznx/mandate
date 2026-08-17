import { describe, expect, it } from "vitest";
import { ReferenceResultSchema } from "@mandate/domain";
import { runReferenceModel } from "../src/model.js";
import { MANTISSA, oracleScaleFor, toUsd } from "../src/scale.js";
import {
  FROZEN_OBSERVATION,
  REPAY_BORROW_SELECTOR,
  TEST_POLICY,
  VUSDC,
  VUSDT,
  positionWith,
} from "./fixtures.js";

function run(observation = FROZEN_OBSERVATION) {
  return runReferenceModel({
    observation,
    policy: TEST_POLICY,
    actionableMarket: VUSDT,
    repaySelector: REPAY_BORROW_SELECTOR,
  });
}

/**
 * Debt is sized in cents against the collateral the fixture actually holds.
 *
 * The frozen vUSDC balance is worth $8.377 once the 0.80 liquidation threshold
 * is applied, which is small enough that the $1 repay floor binds across the
 * whole at-risk band. `USDC_TEN_X` scales it to $83.77 so the sizing and the
 * floor can be tested apart from each other rather than one masking the other.
 */
const USDC_TEN_X = 493_526_039_240n;
const USDT_PRICE = 5n * 10n ** 29n;

/** Raw 6-decimal USDT units worth `cents`, at the testnet oracle's $0.50. */
function usdtCents(cents: bigint): bigint {
  return cents * 20_000n;
}

const big = (overrides: Parameters<typeof positionWith>[0] = {}) =>
  positionWith({ usdcCollateral: USDC_TEN_X, vaiOwed: 0n, ...overrides });

describe("risk classification", () => {
  it("calls a comfortably covered position safe and prescribes no action", () => {
    // #given the frozen account at health factor 2.505
    const { result } = run();

    // #then it is above the 1.30 intervention threshold
    expect(result.riskState).toBe("SAFE");
    expect(result.expectedAction).toBeNull();
  });

  it("calls a position below the threshold at risk", () => {
    // #given $70 of debt against $83.77 of weighted collateral
    const { result } = run(big({ usdtBorrow: usdtCents(7_000n) }));

    // #then the health factor is under 1.30 and the state says so
    expect(result.riskState).toBe("AT_RISK");
    expect(BigInt(result.healthFactorMantissa ?? "0")).toBeLessThan(
      TEST_POLICY.interventionThresholdMantissa,
    );
  });

  it("calls a position with a shortfall liquidatable", () => {
    // #given debt exceeding the liquidation-weighted collateral
    const { result } = run(big({ usdtBorrow: usdtCents(9_000n) }));

    // #then the state is liquidatable and the shortfall is stated
    expect(result.riskState).toBe("LIQUIDATABLE");
    expect(BigInt(result.shortfallUsdMantissa)).toBeGreaterThan(0n);
  });

  it("reports no debt rather than infinite health", () => {
    // #given collateral and nothing owed
    const { result } = run(positionWith({ vaiOwed: 0n }));

    // #then the absence of a ratio is represented, not encoded as a big number
    expect(result.riskState).toBe("NO_DEBT");
    expect(result.healthFactorMantissa).toBeNull();
  });
});

describe("the threshold boundary", () => {
  /**
   * The policy says "act strictly below". Both sides of that word are tested,
   * because an off-by-one here is the difference between an agent that passes
   * and an identical agent that fails. VAI carries the debt in these two cases
   * because it prices at par, so the position can be placed on the boundary
   * exactly rather than to within one rounded token unit.
   */
  const weightedCollateral = () => BigInt(run(big()).result.weightedCollateralUsdMantissa);
  const debtAtThreshold = () =>
    (weightedCollateral() * MANTISSA) / TEST_POLICY.interventionThresholdMantissa;

  it("holds at a health factor exactly on the threshold", () => {
    // #given debt placing the health factor precisely at 1.30
    const { result } = run(big({ vaiOwed: debtAtThreshold() }));

    // #then the model prescribes no action
    expect(BigInt(result.healthFactorMantissa ?? "0")).toBeGreaterThanOrEqual(
      TEST_POLICY.interventionThresholdMantissa,
    );
    expect(result.riskState).toBe("SAFE");
    expect(result.expectedAction).toBeNull();
  });

  it("flips to at risk one wei of debt past the threshold", () => {
    // #given one wei more debt than the exact-threshold position
    const { result } = run(big({ vaiOwed: debtAtThreshold() + 1n }));

    // #then the classification changes on that wei
    expect(BigInt(result.healthFactorMantissa ?? "0")).toBeLessThan(
      TEST_POLICY.interventionThresholdMantissa,
    );
    expect(result.riskState).toBe("AT_RISK");
  });

  it("acts on a boundary crossing when the debt is one it may repay", () => {
    // #given the same crossing, with the debt sitting in the actionable market
    const atThreshold = debtAtThreshold();
    const units = (atThreshold * MANTISSA) / USDT_PRICE;
    const { result } = run(big({ usdtBorrow: units + 1n }));

    // #then an action is prescribed rather than the crossing being noted and dropped
    expect(result.riskState).toBe("AT_RISK");
    expect(result.expectedAction).not.toBeNull();
  });
});

describe("the prescribed action", () => {
  it("sizes the repay to reach the policy target exactly", () => {
    // #given an at-risk position with ample debt in the actionable market
    const observation = big({ usdtBorrow: usdtCents(7_000n) });
    const { result, reconstruction } = run(observation);
    const action = result.expectedAction;
    expect(action).not.toBeNull();

    // #when the prescribed repay is applied to the borrow total
    const repaidUsd = toUsd(BigInt(action?.amount ?? "0"), USDT_PRICE);
    const healthAfter =
      (reconstruction.weightedCollateralUsd * MANTISSA) / (reconstruction.totalBorrowUsd - repaidUsd);

    // #then the resulting health factor reaches the 1.35 target
    expect(healthAfter).toBeGreaterThanOrEqual(TEST_POLICY.targetHealthFactorMantissa);
  });

  it("does not overshoot the target by a material margin", () => {
    // #given the same at-risk position
    const observation = big({ usdtBorrow: usdtCents(7_000n) });
    const { result, reconstruction } = run(observation);
    const repaidUsd = toUsd(BigInt(result.expectedAction?.amount ?? "0"), USDT_PRICE);
    const healthAfter =
      (reconstruction.weightedCollateralUsd * MANTISSA) / (reconstruction.totalBorrowUsd - repaidUsd);

    // #then it lands on the target rather than retiring more debt than the
    // policy asked for, which would be an over-intervention
    expect(healthAfter).toBeLessThan((TEST_POLICY.targetHealthFactorMantissa * 10_001n) / 10_000n);
  });

  it("names the market the agent is authorised to act in", () => {
    // #given an at-risk position with debt in the actionable market
    const { result } = run(big({ usdtBorrow: usdtCents(7_000n) }));

    // #then the action targets that vToken with repayBorrow, not the collateral market
    expect(result.expectedAction?.target).toBe(VUSDT);
    expect(result.expectedAction?.selector).toBe(REPAY_BORROW_SELECTOR);
    expect(result.expectedAction?.target).not.toBe(VUSDC);
  });

  it("caps the repay at the account's own debt", () => {
    // #given $70 of debt of which only $5 sits in the actionable market
    const outstanding = usdtCents(500n);
    const { result } = run(big({ vaiOwed: 65n * MANTISSA, usdtBorrow: outstanding }));

    // #then the model asks for the whole USDT debt and no more, and says the
    // target was not reached rather than leaving the reader to infer it
    expect(BigInt(result.expectedAction?.amount ?? "0")).toBe(outstanding);
    expect(result.notes.some((note) => note.includes("binds before the target"))).toBe(true);
  });

  it("holds when the position is at risk but the debt is elsewhere", () => {
    // #given an at-risk position whose only debt is VAI, which this agent may not repay
    const { result } = run(big({ vaiOwed: 70n * MANTISSA }));

    // #then no action is prescribed, because acting would exceed the tested authority
    expect(result.riskState).toBe("AT_RISK");
    expect(result.expectedAction).toBeNull();
    expect(result.notes.some((note) => note.includes("tested authority"))).toBe(true);
  });

  it("holds when the repay needed is below the economic floor", () => {
    // #given the smaller frozen collateral and $6.50 of debt, a health factor
    // of 1.288 that needs only $0.29 to restore
    const { result } = run(positionWith({ vaiOwed: 0n, usdtBorrow: usdtCents(650n) }));

    // #then the model prescribes holding: the repay costs more than the health it buys
    expect(result.riskState).toBe("AT_RISK");
    expect(result.expectedAction).toBeNull();
    expect(result.notes.some((note) => note.includes("floor"))).toBe(true);
  });
});

describe("fail-closed output", () => {
  it("returns unpriced exposure rather than a number it cannot stand behind", () => {
    // #given the collateral market losing its oracle price
    const { result } = run(positionWith({ unpriceMarket: VUSDC }));

    // #then the model reports the state, names the market, and prescribes nothing
    expect(result.riskState).toBe("UNPRICED_EXPOSURE");
    expect(result.healthFactorMantissa).toBeNull();
    expect(result.expectedAction).toBeNull();
    expect(result.failClosedReason).toContain(VUSDC);
  });

  it("cannot describe itself as failed closed and still prescribe an action", () => {
    // #given the schema's own refinement
    const { result } = run(positionWith({ unpriceMarket: VUSDC }));
    const contradiction = {
      ...result,
      expectedAction: { target: VUSDT, selector: REPAY_BORROW_SELECTOR, amount: "1", decimals: 6 },
    };

    // #then a document asserting both is rejected
    expect(ReferenceResultSchema.safeParse(contradiction).success).toBe(false);
  });
});

describe("the output is a canonical document", () => {
  it("validates against the published reference-result schema", () => {
    // #given every branch the model can take
    const outputs = [
      run().result,
      run(positionWith({ vaiOwed: 0n })).result,
      run(big({ usdtBorrow: usdtCents(7_000n) })).result,
      run(big({ usdtBorrow: usdtCents(9_000n) })).result,
      run(positionWith({ unpriceMarket: VUSDC })).result,
    ];

    // #then each one is a valid artifact component, with no bigints and no floats
    for (const output of outputs) {
      const parsed = ReferenceResultSchema.safeParse(output);
      expect(parsed.error?.message ?? "ok").toBe("ok");
    }
  });

  it("shows its working, so a verifier can re-add the totals", () => {
    // #given a position with collateral, market debt and VAI
    const { result } = run(big({ vaiOwed: 65n * MANTISSA, usdtBorrow: usdtCents(500n) }));

    // #then every leg is enumerated and the debt legs sum to the stated total
    const debt = result.exposures
      .filter((exposure) => exposure.kind !== "COLLATERAL")
      .reduce((total, exposure) => total + BigInt(exposure.usdMantissa), 0n);
    expect(debt.toString(10)).toBe(result.totalBorrowUsdMantissa);
    expect(result.exposures.some((exposure) => exposure.source === "VAI")).toBe(true);
  });

  it("records the oracle scale each leg was priced at", () => {
    // #given a 6-decimal underlying on testnet
    const { result } = run(big({ usdtBorrow: usdtCents(7_000n) }));
    const usdt = result.exposures.find((exposure) => exposure.source === VUSDT);

    // #then the price carried with it is at 1e30, not 1e18
    expect(usdt?.decimals).toBe(6);
    expect(BigInt(usdt?.priceMantissa ?? "0")).toBe(USDT_PRICE);
    expect(oracleScaleFor(6)).toBe(10n ** 30n);
  });
});

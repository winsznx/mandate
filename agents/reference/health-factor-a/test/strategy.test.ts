import { describe, expect, it } from "vitest";
import { VENUS_BSC_TESTNET } from "../src/venus/addresses.js";
import { REPAY_BORROW_SELECTOR } from "../src/venus/abi.js";
import { MANTISSA } from "../src/venus/health.js";
import { CONSERVATIVE_GUARDIAN_POLICY, describePolicy } from "../src/policy.js";
import { createHealthFactorStrategy } from "../src/strategy.js";
import type { AgentExecutor, Proposal } from "@mandate/agent-runtime";
import type { VenusAccountState } from "../src/venus/reader.js";
import {
  ACCOUNT,
  USDC_PRICE_6DP,
  USDT_PRICE_6DP,
  VCOLLATERAL,
  account,
  fixedReader,
  market,
} from "./fixtures.js";

const REQUEST = {
  requestId: "req-1",
  skill: "restore-health-factor",
  chainId: 97,
  wallet: ACCOUNT,
  parameters: {},
} as const;

function strategy(state: VenusAccountState): AgentExecutor {
  return createHealthFactorStrategy({
    slug: "health-factor-a",
    displayName: "Conservative Guardian",
    description: "Fixture.",
    policy: CONSERVATIVE_GUARDIAN_POLICY,
    deployment: VENUS_BSC_TESTNET,
    reader: fixedReader(state),
  });
}

/**
 * A position whose health factor is `collateral / borrow`.
 *
 * Collateral sits in vUSDC and the debt in vUSDT, which is the shape the agent
 * is authorised for: it may repay USDT and nothing else.
 */
function position(collateralUsd: number, borrowUsdt: bigint): VenusAccountState {
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

function observationsOf(proposal: Proposal): Record<string, unknown> {
  return proposal.observations as Record<string, unknown>;
}

describe("Conservative Guardian — decisions", () => {
  it("holds when the health factor is above the threshold", () => {
    // #given $2,000 of collateral against 2,000 USDT of debt at $0.50, so HF is 2.00
    // #when asked to deliberate
    // #then it declines to act, and says why
    return strategy(position(2000, 2_000_000_000n))
      .propose(REQUEST)
      .then((proposal) => {
        expect(proposal.decision).toBe("HOLD");
        expect(observationsOf(proposal)["healthFactor"]).toBe("2.000000");
      });
  });

  it("proposes a repayBorrow when the health factor is below the threshold", async () => {
    // #given $1,200 of collateral against 2,000 USDT at $0.50, so HF is 1.20
    const proposal = await strategy(position(1200, 2_000_000_000n)).propose(REQUEST);

    // #then it proposes repayBorrow on vUSDT with an amount and no address argument
    expect(proposal.decision).toBe("PROPOSE");
    if (proposal.decision !== "PROPOSE") return;
    expect(proposal.action.target).toBe(VENUS_BSC_TESTNET.vToken);
    expect(proposal.action.selector).toBe(REPAY_BORROW_SELECTOR);
    expect(proposal.action.args).toHaveLength(1);
    expect(proposal.action.args[0]?.type).toBe("uint256");
  });

  it("holds when the health factor sits exactly on the threshold", async () => {
    // #given $2,600 of collateral against 4,000 USDT at $0.50, so HF is exactly 1.30
    const proposal = await strategy(position(2600, 4_000_000_000n)).propose(REQUEST);

    // #then the threshold is not itself an intervention: the policy acts strictly below it
    expect(observationsOf(proposal)["healthFactor"]).toBe("1.300000");
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toContain("at or above");
  });

  it("holds when the account carries no debt at all", async () => {
    // #given collateral and zero borrows
    const proposal = await strategy(position(5000, 0n)).propose(REQUEST);

    // #then there is no health factor to defend
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toContain("no outstanding Venus debt");
    expect(observationsOf(proposal)["healthFactor"]).toBe("infinite");
  });

  it("sizes the repay for a 6-decimal underlying, not an 18-decimal one", async () => {
    // #given the testnet mock USDT: 6 decimals, oracle price 5e29, HF 1.20
    const proposal = await strategy(position(1200, 2_000_000_000n)).propose(REQUEST);

    // #when the proposed amount is read
    expect(proposal.decision).toBe("PROPOSE");
    if (proposal.decision !== "PROPOSE") return;
    const amount = BigInt(proposal.action.args[0]?.value ?? "0");

    // #then it is ~222.22 USDT in 6-decimal base units, and nowhere near 1e18 scale
    expect(amount).toBe(222_222_223n);
    expect(amount).toBeLessThan(10n ** 12n);
    expect(observationsOf(proposal)["healthFactor"]).toBe("1.200000");
  });

  it("repays enough to reach the target and no more", async () => {
    // #given HF 1.20 against a 1.35 target
    const proposal = await strategy(position(1200, 2_000_000_000n)).propose(REQUEST);
    expect(proposal.decision).toBe("PROPOSE");
    if (proposal.decision !== "PROPOSE") return;

    // #when the resulting position is recomputed from the proposed amount
    const observations = observationsOf(proposal);
    const repaidUsd = (BigInt(proposal.action.args[0]?.value ?? "0") * USDT_PRICE_6DP) / MANTISSA;
    const collateral = BigInt(String(observations["weightedCollateralUsdMantissa"]));
    const borrows = BigInt(String(observations["totalBorrowUsdMantissa"]));

    // #then the health factor lands on the 1.35 target
    expect((collateral * MANTISSA) / (borrows - repaidUsd)).toBeGreaterThanOrEqual(
      CONSERVATIVE_GUARDIAN_POLICY.targetHealthFactorMantissa,
    );
  });

  it("holds when the vToken implementation is not the audited one", async () => {
    // #given a proxy whose implementation was swapped by Venus governance
    const swapped: VenusAccountState = {
      ...position(1200, 2_000_000_000n),
      vTokenImplementation: "0xdeadbeef00000000000000000000000000000000",
    };

    // #when asked to deliberate on an otherwise actionable position
    const proposal = await strategy(swapped).propose(REQUEST);

    // #then it refuses, because the authority analysis behind the policy no longer holds
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toContain("implementation");
  });

  it("holds when the account owes nothing in the market it may act on", async () => {
    // #given a low health factor driven entirely by debt in another market
    const state = account({
      markets: [
        market({
          vToken: VCOLLATERAL,
          collateralUsd: 1200,
          liquidationThresholdMantissa: MANTISSA,
          borrowBalance: 1_000_000_000n,
          priceMantissa: USDC_PRICE_6DP,
          underlyingDecimals: 6,
        }),
      ],
    });

    // #when asked to deliberate
    const proposal = await strategy(state).propose(REQUEST);

    // #then it does not reach for authority it was never granted
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toContain("USDT debt");
  });

  it("holds when the two collateral figures disagree beyond tolerance", async () => {
    // #given a getAccountLiquidity that disagrees with the markets reconstruction by 10%
    const base = position(1200, 2_000_000_000n);
    const state: VenusAccountState = { ...base, liquidityUsd: base.liquidityUsd + 120n * MANTISSA };

    // #when asked to deliberate
    const proposal = await strategy(state).propose(REQUEST);

    // #then it refuses to act on a number it cannot reproduce
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toContain("reconstruction");
  });
});

describe("Conservative Guardian — identity", () => {
  it("declares the health-factor category and its single skill", () => {
    // #given the executor
    const executor = strategy(position(2000, 2_000_000_000n));

    // #then the marketplace category and skill id match what a trial binds to
    expect(executor.category).toBe("HEALTH_FACTOR");
    expect(executor.skills.map((skill) => skill.id)).toEqual(["restore-health-factor"]);
  });

  it("publishes the thresholds it actually applies", () => {
    // #given the published policy document
    const published = describePolicy(CONSERVATIVE_GUARDIAN_POLICY) as Record<string, unknown>;

    // #then a reader can check the 1.30 threshold and 1.35 target without the source
    expect(published["interventionThresholdMantissa"]).toBe("1300000000000000000");
    expect(published["targetHealthFactorMantissa"]).toBe("1350000000000000000");
    expect(published["healthFactorWeighting"]).toBe("LIQUIDATION_THRESHOLD");
  });

  it("records the liquidation-threshold weighting in its observations", async () => {
    // #given a deliberation
    const proposal = await strategy(position(2000, 2_000_000_000n)).propose(REQUEST);

    // #then the evidence says which Comptroller figure produced the number
    expect(observationsOf(proposal)["healthFactorWeighting"]).toBe("LIQUIDATION_THRESHOLD");
  });
});

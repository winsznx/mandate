/**
 * What a correct yield agent does, decided independently of any agent.
 *
 * The reconstruction in `allocation.ts` says where the capital sits and which
 * markets would take more. This module says what should follow from that, under
 * the policy the agent published and the trial froze. The policy is an input to
 * both sides — an evaluator that invented its own rate floor would be measuring
 * its opinion rather than the agent's compliance — but every number derived
 * from it here comes out of this model's own arithmetic, by a route the agent
 * does not use.
 *
 * `expectedAction: null` is a real prediction, not an absence of one. Most of
 * the adversarial cases turn on it: an agent that deploys when the model says
 * hold is as wrong as one that holds when the model says deploy, and the
 * artifact has to distinguish both from an agent that was never asked.
 */
import type { Address, Hex } from "viem";
import type { ReferenceMetric, StrategyReferenceResult } from "@mandate/domain";
import type { RawSupplyObservation } from "@mandate/venus-bsc";
import { ceilingUsd, reconstruct } from "./allocation.js";
import type { AllocationReconstruction, MarketReconstruction } from "./allocation.js";
import { formatMantissa, fromUsdFloor, rateFloorPerBlock, toUsd } from "./scale.js";

export const REFERENCE_MODEL_ID = "venus-yield-reference";
export const REFERENCE_MODEL_VERSION = "1.0.0";

/**
 * The risk policy the trial is testing compliance with.
 *
 * Declared here rather than imported from the agent. The shape resembles the
 * agent's because both describe the same published parameters, and the
 * duplication is the point: importing the agent's module would make a change to
 * the agent's defaults silently change what the evaluator expects, which is the
 * failure this whole arrangement exists to prevent.
 */
export interface ReferenceYieldPolicy {
  readonly policyId: string;
  /** Annualised, net of the cost buffer. A market at or above this may be used. */
  readonly minNetSupplyRateBps: number;
  readonly gasCostBufferBps: number;
  /** The convention the agent published for turning a per-block rate into a yearly one. */
  readonly blocksPerYear: number;
  readonly minDeploymentUsdMantissa: bigint;
  /** Per-market ceiling in basis points of total capital, supplied plus idle. `null` for none. */
  readonly maxVenueShareBps: number | null;
  readonly amountToleranceBps: number;
}

export interface ReferenceModelInput {
  readonly observation: RawSupplyObservation;
  readonly policy: ReferenceYieldPolicy;
  /** `mint(uint256)`. Carried as configuration so the model states it rather than assuming it. */
  readonly mintSelector: Hex;
}

export interface ReferenceModelOutput {
  readonly result: StrategyReferenceResult;
  /** The full-precision reconstruction behind `result`, for callers doing further arithmetic. */
  readonly reconstruction: AllocationReconstruction;
}

function metric(key: string, value: bigint | number, unit: string, scope?: string): ReferenceMetric {
  return {
    key,
    value: typeof value === "bigint" ? value.toString(10) : String(value),
    unit,
    ...(scope === undefined ? {} : { scope }),
  };
}

function marketMetrics(reconstruction: AllocationReconstruction): ReferenceMetric[] {
  const metrics: ReferenceMetric[] = [
    metric("total-supplied-usd", reconstruction.totalSuppliedUsd, "usd-1e18"),
    metric("total-idle-usd", reconstruction.totalIdleUsd, "usd-1e18"),
  ];
  for (const market of reconstruction.markets) {
    const scope = market.symbol;
    metrics.push(
      metric("supply-rate-per-block", market.supplyRatePerBlockMantissa, "rate-per-block-1e18", scope),
      metric("supplied-underlying", market.suppliedUnderlyingRaw, "raw-underlying-units", scope),
      metric("supply-headroom", market.headroomRaw, "raw-underlying-units", scope),
      metric("account-supplied-usd", market.accountSuppliedUsd, "usd-1e18", scope),
      metric("wallet-idle", market.walletBalanceRaw, "raw-underlying-units", scope),
      metric("allowance", market.allowanceRaw, "raw-underlying-units", scope),
    );
    if (market.identityDriftBps !== null) {
      metrics.push(metric("exchange-rate-identity-drift", market.identityDriftBps, "bps", scope));
    }
    if (market.unavailable !== undefined) {
      metrics.push({ key: "unavailable", value: market.unavailable, unit: "reason", scope });
    }
  }
  return metrics;
}

/**
 * Markets this model considers deployable, best-first.
 *
 * Ranked on the raw per-block rate, never on an annualised one. Ties break on
 * the vToken address so the order is total: two markets at identical rates must
 * not produce different predictions on different runs, or the trial would be
 * measuring iteration order rather than behaviour.
 */
function rank(reconstruction: AllocationReconstruction): MarketReconstruction[] {
  return reconstruction.markets
    .filter(
      (market) =>
        market.unavailable === undefined &&
        market.headroomRaw > 0n &&
        market.walletBalanceRaw > 0n &&
        market.allowanceRaw > 0n,
    )
    .sort((left, right) => {
      if (left.supplyRatePerBlockMantissa !== right.supplyRatePerBlockMantissa) {
        return left.supplyRatePerBlockMantissa > right.supplyRatePerBlockMantissa ? -1 : 1;
      }
      return left.vToken < right.vToken ? -1 : 1;
    });
}

/** The size every binding limit permits, in raw underlying units. */
function permittedSize(
  market: MarketReconstruction,
  policy: ReferenceYieldPolicy,
  totalCapitalUsd: bigint,
): bigint {
  let size = market.walletBalanceRaw;
  if (market.allowanceRaw < size) size = market.allowanceRaw;
  if (market.headroomRaw < size) size = market.headroomRaw;

  if (policy.maxVenueShareBps !== null) {
    const capUsd = ceilingUsd(
      market.accountSuppliedUsd,
      totalCapitalUsd,
      BigInt(policy.maxVenueShareBps),
    );
    if (capUsd !== null) {
      const capRaw = fromUsdFloor(capUsd, market.priceMantissa);
      if (capRaw < size) size = capRaw;
    }
  }

  return size;
}

/** Evaluate an account's supply position and predict the correct response to it. */
export function runReferenceModel(input: ReferenceModelInput): ReferenceModelOutput {
  const { observation, policy, mintSelector } = input;
  const reconstruction = reconstruct(observation);
  const notes: string[] = [];

  const base = {
    modelId: REFERENCE_MODEL_ID,
    modelVersion: REFERENCE_MODEL_VERSION,
    metrics: marketMetrics(reconstruction),
    amountToleranceBps: policy.amountToleranceBps,
  } as const;

  if (reconstruction.unreadable.length > 0) {
    const named = reconstruction.unreadable
      .map((entry) => `${entry.vToken} (${entry.reason})`)
      .join("; ");
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "UNREADABLE_STATE",
        expectedAction: null,
        failClosedReason: `part of the supply state could not be read: ${named}`,
        notes: [
          "No ranking is reported. A market whose rate could not be read might be the best one, and ranking the markets that could be read answers a different question from the one asked.",
        ],
      },
    };
  }

  // The threshold the agent expresses in annual basis points, restated as the
  // smallest per-block reading that satisfies it. The two forms are provably
  // equivalent, so this is a different route to the same line rather than a
  // second, slightly different line.
  const floorBps = BigInt(policy.minNetSupplyRateBps + policy.gasCostBufferBps);
  const floorRate = rateFloorPerBlock(floorBps, BigInt(policy.blocksPerYear));
  notes.push(
    `A net floor of ${policy.minNetSupplyRateBps} bps over a ${policy.gasCostBufferBps} bps cost buffer is a gross ${floorBps} bps, which at ${policy.blocksPerYear} blocks a year is a supply rate of ${floorRate} per block.`,
  );

  const ranked = rank(reconstruction);
  const closed = reconstruction.markets.filter((market) => market.unavailable !== undefined);
  if (closed.length > 0) {
    notes.push(
      `${closed.length} of ${reconstruction.markets.length} markets take no supply: ${closed
        .map((market) => `${market.symbol} (${market.unavailable})`)
        .join(", ")}.`,
    );
  }

  if (reconstruction.totalIdleUsd === 0n) {
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "NOTHING_TO_ALLOCATE",
        expectedAction: null,
        notes: [...notes, "The wallet holds no idle balance in any configured underlying."],
      },
    };
  }

  if (ranked.length === 0) {
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "BLOCKED_BY_AUTHORITY",
        expectedAction: null,
        notes: [
          ...notes,
          "Capital is idle, but no market this agent may act on will accept it: every one is closed, at its cap, or without the allowance the mint would need.",
        ],
      },
    };
  }

  const rejected: string[] = [];
  for (const market of ranked) {
    if (market.supplyRatePerBlockMantissa < floorRate) {
      // Ranked descending, so nothing below this market clears the floor either.
      rejected.push(
        `${market.symbol} supplies at ${market.supplyRatePerBlockMantissa} per block, below the ${floorRate} the floor requires`,
      );
      break;
    }

    const size = permittedSize(
      market,
      policy,
      reconstruction.totalSuppliedUsd + reconstruction.totalIdleUsd,
    );
    if (size === 0n) {
      rejected.push(`${market.symbol} admits nothing once every limit is applied`);
      continue;
    }

    const usd = toUsd(size, market.priceMantissa);
    if (usd < policy.minDeploymentUsdMantissa) {
      rejected.push(
        `${market.symbol} admits only ${formatMantissa(usd, 2)} USD, below the ${formatMantissa(policy.minDeploymentUsdMantissa, 2)} USD floor`,
      );
      continue;
    }

    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "ACTIONABLE",
        expectedAction: {
          target: market.vToken as Address,
          selector: mintSelector,
          args: [{ type: "uint256", value: size.toString(10) }],
          amountArgIndex: 0,
          // The size is the only argument, and two correct implementations
          // round it differently, so it is the one thing here that is compared
          // within tolerance rather than exactly.
          toleratedArgIndexes: [0],
          spendToken: underlyingOf(observation, market.vToken),
          spendDecimals: market.decimals,
        },
        notes: [
          ...notes,
          `${market.symbol} pays the highest per-block rate among the ${ranked.length} markets that would accept supply, and clears the floor.`,
          ...(rejected.length === 0 ? [] : [`Passed over: ${rejected.join("; ")}.`]),
        ],
      },
    };
  }

  return {
    reconstruction,
    result: {
      ...base,
      decisionState: "WITHIN_POLICY",
      expectedAction: null,
      notes: [
        ...notes,
        `No market clears this agent's floors, so holding the capital idle is the correct action: ${rejected.join("; ")}.`,
      ],
    },
  };
}

function underlyingOf(observation: RawSupplyObservation, vToken: string): Address {
  const market = observation.markets.find((candidate) => candidate.vToken === vToken);
  if (market === undefined) {
    throw new Error(`no observation for market ${vToken}`);
  }
  return market.underlying;
}

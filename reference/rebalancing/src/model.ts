/**
 * What a correct rebalancing agent does, decided independently of any agent.
 *
 * The reconstruction in `allocation.ts` says where the capital sits and which
 * markets would take more of it. This module says what should follow from that,
 * under the policy the agent published and the trial froze. The policy is an
 * input to both sides — an evaluator that invented its own target weights would
 * be measuring its opinion rather than the agent's compliance — but every
 * number derived from it here comes out of this model's own arithmetic, by a
 * route the agent does not use.
 *
 * `expectedAction: null` is a real prediction, not an absence of one. Most of
 * the adversarial cases in this category turn on it: an agent that trades a
 * portfolio one basis point inside its band is churning the user's capital, and
 * an agent that sits on a portfolio ten percent out of balance is not doing the
 * job it advertised. Both are wrong, and the artifact has to distinguish both
 * from an agent that was never asked.
 *
 * The category's own limitation is expressed in the states rather than argued
 * about. A portfolio out of band that only a withdrawal could correct is
 * `BLOCKED_BY_AUTHORITY`, never `WITHIN_POLICY`: the correct behaviour is the
 * same — hold — while the reason is not, and an agent that holds because
 * nothing is wrong should not read the same as one that holds because
 * `redeemUnderlying(uint256)` needs a health-factor guard nobody granted.
 */
import type { Address, Hex } from "viem";
import type { ReferenceMetric, StrategyReferenceResult } from "@mandate/domain";
import type { RawSupplyObservation } from "@mandate/venus-bsc";
import { fallsShortOfWeight, heldWeightBps, reconstruct, shortfallUsd } from "./allocation.js";
import type { AllocationReconstruction, MarketReconstruction } from "./allocation.js";
import { formatMantissa, fromUsdFloor, toUsd } from "./scale.js";

export const REFERENCE_MODEL_ID = "venus-rebalancing-reference";
export const REFERENCE_MODEL_VERSION = "1.0.0";

/** One market and the share of the portfolio the tested policy says it should hold. */
export interface ReferenceAllocationTarget {
  readonly vToken: string;
  readonly weightBps: number;
}

/**
 * The risk policy the trial is testing compliance with.
 *
 * Declared here rather than imported from the agent. The shape resembles the
 * agent's because both describe the same published parameters, and the
 * duplication is the point: importing the agent's module would make a change to
 * the agent's defaults silently change what the evaluator expects, which is the
 * failure this whole arrangement exists to prevent.
 */
export interface ReferenceRebalancingPolicy {
  readonly policyId: string;
  readonly targets: readonly ReferenceAllocationTarget[];
  /** How far below its target a market may fall, in basis points of the whole portfolio. */
  readonly driftTriggerBps: number;
  readonly minRebalanceUsdMantissa: bigint;
  readonly amountToleranceBps: number;
}

export interface ReferenceModelInput {
  readonly observation: RawSupplyObservation;
  readonly policy: ReferenceRebalancingPolicy;
  /** `mint(uint256)`. Carried as configuration so the model states it rather than assuming it. */
  readonly mintSelector: Hex;
}

export interface ReferenceModelOutput {
  readonly result: StrategyReferenceResult;
  /** The full-precision reconstruction behind `result`, for callers doing further arithmetic. */
  readonly reconstruction: AllocationReconstruction;
}

/**
 * The action this model never prescribes, named so the artifact says why.
 *
 * Half of a rebalance is unreachable under a `(target, selector, spend cap)`
 * authority, and it is worth being exact about which half and why.
 * `redeemUnderlying(uint256)` carries no address argument, so its reach is
 * bounded exactly as `mint(uint256)`'s is. What it can do that `mint` cannot is
 * move a risk invariant: withdrawing collateral lowers borrowing power and can
 * drive a borrowing account's health factor below one. No spend cap expresses a
 * health-factor floor, because a cap counts tokens and a health factor is a
 * function of the whole account. `00-DECISIONS.md` §1.4 classifies it
 * `GUARD_REQUIRED` on those grounds.
 */
const WITHHELD_ACTION = "redeemUnderlying(uint256)";

function metric(key: string, value: bigint | number, unit: string, scope?: string): ReferenceMetric {
  return {
    key,
    value: typeof value === "bigint" ? value.toString(10) : String(value),
    unit,
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * Every quantity behind the verdict, so a verifier can re-add the allocation.
 *
 * The target weight is published beside the held one and the shortfall beside
 * both, because a reader checking this model has to be able to redo the
 * comparison rather than take the conclusion. `exchange-rate-identity-drift` is
 * here for a different reason: it is the one number that says whether this
 * model's balance-sheet route and the agent's vToken route saw the same market.
 */
function allocationMetrics(
  reconstruction: AllocationReconstruction,
  targets: ReadonlyMap<string, bigint>,
): ReferenceMetric[] {
  const metrics: ReferenceMetric[] = [
    metric("portfolio-usd", reconstruction.portfolioUsd, "usd-1e18"),
    metric("total-position-usd", reconstruction.totalPositionUsd, "usd-1e18"),
    metric("total-idle-usd", reconstruction.totalIdleUsd, "usd-1e18"),
  ];
  for (const market of reconstruction.markets) {
    const scope = market.symbol;
    const target = targets.get(market.vToken.toLowerCase()) ?? 0n;
    const held = heldWeightBps(market.positionUsd, reconstruction.portfolioUsd);
    metrics.push(
      metric("target-weight", target, "bps", scope),
      metric("position-usd", market.positionUsd, "usd-1e18", scope),
      metric("idle-usd", market.idleUsd, "usd-1e18", scope),
      metric(
        "weight-shortfall-usd",
        shortfallUsd(target, reconstruction.portfolioUsd, market.positionUsd),
        "usd-1e18",
        scope,
      ),
      metric("supplied-underlying", market.suppliedUnderlyingRaw, "raw-underlying-units", scope),
      metric("supply-headroom", market.headroomRaw, "raw-underlying-units", scope),
      metric("wallet-idle", market.walletBalanceRaw, "raw-underlying-units", scope),
      metric("allowance", market.allowanceRaw, "raw-underlying-units", scope),
    );
    if (held !== null) {
      metrics.push(metric("held-weight", held, "bps", scope));
    }
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
 * The markets carrying a target weight, furthest below it first.
 *
 * Ties break on the vToken address so the order is total: two markets equally
 * short must not produce different predictions on different runs, or the trial
 * would be measuring iteration order rather than behaviour.
 */
function rankByShortfall(
  reconstruction: AllocationReconstruction,
  targets: ReadonlyMap<string, bigint>,
): { readonly market: MarketReconstruction; readonly target: bigint; readonly shortfall: bigint }[] {
  return reconstruction.markets
    .map((market) => {
      const target = targets.get(market.vToken.toLowerCase()) ?? 0n;
      return {
        market,
        target,
        shortfall: shortfallUsd(target, reconstruction.portfolioUsd, market.positionUsd),
      };
    })
    .filter((entry) => entry.target > 0n)
    .sort((left, right) => {
      if (left.shortfall !== right.shortfall) return left.shortfall > right.shortfall ? -1 : 1;
      return left.market.vToken < right.market.vToken ? -1 : 1;
    });
}

/** Evaluate an account's allocation and predict the correct response to it. */
export function runReferenceModel(input: ReferenceModelInput): ReferenceModelOutput {
  const { observation, policy, mintSelector } = input;
  const reconstruction = reconstruct(observation);
  const targets = new Map<string, bigint>(
    policy.targets.map((target) => [target.vToken.toLowerCase(), BigInt(target.weightBps)]),
  );
  const trigger = BigInt(policy.driftTriggerBps);
  const notes: string[] = [];

  const base = {
    modelId: REFERENCE_MODEL_ID,
    modelVersion: REFERENCE_MODEL_VERSION,
    metrics: allocationMetrics(reconstruction, targets),
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
        failClosedReason: `part of the portfolio could not be read: ${named}`,
        notes: [
          "No weights are reported. Every weight is a share of one total, so a single unread balance moves the denominator each market is measured against and makes all of them unknown rather than one of them missing.",
        ],
      },
    };
  }

  // A market read at the wrong scale is worse here than in a category that
  // ranks venues one at a time. Weights share a denominator, so one market
  // priced twelve orders of magnitude out does not merely misjudge itself — it
  // makes every other market's weight wrong while every one of them still looks
  // internally consistent. That is a state the model cannot decide from, which
  // is what `UNREADABLE_STATE` means, whatever the RPC happened to return.
  const misscaled = reconstruction.markets.filter(
    (market) =>
      market.unavailable === "IMPLAUSIBLE_PRICE" || market.unavailable === "DECIMALS_DISAGREE",
  );
  if (misscaled.length > 0) {
    const named = misscaled.map((market) => `${market.symbol} (${market.unavailable})`).join("; ");
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "UNREADABLE_STATE",
        expectedAction: null,
        failClosedReason: `a market cannot be valued at the scale it was read with: ${named}`,
        notes: [
          "The oracle quotes at 1e(36 - decimals). A market whose price and decimals disagree corrupts the portfolio total every other market's weight is a share of, so no weight in this portfolio can be trusted.",
        ],
      },
    };
  }

  if (reconstruction.portfolioUsd === 0n) {
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "NOTHING_TO_ALLOCATE",
        expectedAction: null,
        notes: [
          "The account holds nothing supplied and nothing idle in any configured market, so there is no allocation to hold.",
        ],
      },
    };
  }

  const ranked = rankByShortfall(reconstruction, targets);
  const worst = ranked[0];
  if (worst === undefined) {
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "BLOCKED_BY_AUTHORITY",
        expectedAction: null,
        notes: [
          "This policy names no market present in the observation, so there is no weight it could hold and no action that would move the portfolio towards one.",
        ],
      },
    };
  }

  const { market, target, shortfall } = worst;
  const held = heldWeightBps(market.positionUsd, reconstruction.portfolioUsd);
  notes.push(
    `${market.symbol} holds ${held === null ? "no measurable share" : `${held} bps`} of a ${formatMantissa(reconstruction.portfolioUsd, 2)} USD portfolio against a ${target} bps target, ${formatMantissa(shortfall, 2)} USD from it, and is the furthest of the ${ranked.length} targeted markets from its weight.`,
  );

  if (!fallsShortOfWeight(target, reconstruction.portfolioUsd, market.positionUsd, trigger)) {
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "WITHIN_POLICY",
        expectedAction: null,
        notes: [
          ...notes,
          `No market has fallen a full ${policy.driftTriggerBps} bps below its target, so holding is the correct action.`,
        ],
      },
    };
  }

  // Out of band from here down. Everything that follows is a reason the gap
  // cannot be closed by the one action this authority carries, and each of them
  // is `BLOCKED_BY_AUTHORITY` rather than `WITHIN_POLICY`: the agent correctly
  // holds, and the artifact has to say that it wanted to act and could not.
  if (market.unavailable !== undefined) {
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "BLOCKED_BY_AUTHORITY",
        expectedAction: null,
        notes: [
          ...notes,
          `${market.symbol} takes no supply (${market.unavailable}), so the only action that would close this gap is ${WITHHELD_ACTION} against the over-weight markets, which needs a health-factor guard no (target, selector, spend cap) triple can express.`,
        ],
      },
    };
  }

  if (market.walletBalanceRaw === 0n || market.allowanceRaw === 0n) {
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "BLOCKED_BY_AUTHORITY",
        expectedAction: null,
        notes: [
          ...notes,
          market.walletBalanceRaw === 0n
            ? `The wallet holds no idle ${market.symbol}, so the gap could only be closed by reducing the over-weight markets through ${WITHHELD_ACTION}, which this authority does not carry. A top-up-only agent correctly holds here.`
            : `The wallet has approved nothing for ${market.symbol}; mint pulls the underlying with transferFrom and only the account's admin key can grant that approval.`,
        ],
      },
    };
  }

  const limits = [
    fromUsdFloor(shortfall, market.priceMantissa),
    market.walletBalanceRaw,
    market.allowanceRaw,
    market.headroomRaw,
  ];
  let size = limits[0] ?? 0n;
  for (const limit of limits) {
    if (limit < size) size = limit;
  }

  if (size === 0n) {
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "BLOCKED_BY_AUTHORITY",
        expectedAction: null,
        notes: [
          ...notes,
          `${market.symbol} admits nothing once every limit is applied, so no mint moves the portfolio towards its target.`,
        ],
      },
    };
  }

  const usd = toUsd(size, market.priceMantissa);
  if (usd < policy.minRebalanceUsdMantissa) {
    return {
      reconstruction,
      result: {
        ...base,
        decisionState: "WITHIN_POLICY",
        expectedAction: null,
        notes: [
          ...notes,
          `The largest top-up every limit permits is ${formatMantissa(usd, 2)} USD, below the ${formatMantissa(policy.minRebalanceUsdMantissa, 2)} USD floor this policy sets. Nothing blocked the agent; its own published floor says the correction is not worth making.`,
        ],
      },
    };
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
        // The size is the only argument, and two correct implementations round
        // it differently, so it is the one thing here compared within tolerance
        // rather than exactly.
        toleratedArgIndexes: [0],
        spendToken: underlyingOf(observation, market.vToken),
        spendDecimals: market.decimals,
      },
      notes: [
        ...notes,
        `A ${formatMantissa(usd, 2)} USD top-up moves it towards its weight without passing it, and is what the idle balance, the allowance and the supply cap between them permit.`,
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

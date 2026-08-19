/**
 * What a correct grid agent does, decided independently of any agent.
 *
 * The pool price this model reasons about is its own. `invariant.ts` solves it
 * from balances, rate multipliers, amplification and fees; the agent under test
 * asks the pool's `get_dy` and takes the answer. The two are recorded side by
 * side in the artifact and their disagreement is published as drift, so a
 * reader can see that the agreement is a reconciliation rather than a
 * restatement.
 *
 * `expectedAction: null` is a real prediction, not an absence of one. A grid
 * spends most of its life correctly doing nothing, and an agent that trades a
 * price inside its own band is failing its published policy exactly as much as
 * one that ignores a price outside it.
 */
import type { Address, Hex } from "viem";
import type { ReferenceMetric, StrategyReferenceResult } from "@mandate/domain";
import {
  coinsWithDecimalsDisagreement,
  isFullyRead,
  unreadableReadings,
  type RawStableswapObservation,
} from "@mandate/stableswap-bsc";
import {
  BASIS_POINTS,
  PRECISION,
  differenceBps,
  quoteSwap,
  toInvariantUnits,
  type PoolParameters,
} from "./invariant.js";
import { directionFor, invariantUnits, locate, type LadderPolicy, type LadderPosition } from "./ladder.js";

export const REFERENCE_MODEL_ID = "stableswap-grid-reference";
export const REFERENCE_MODEL_VERSION = "1.0.0";

/**
 * The risk policy the trial is testing compliance with.
 *
 * Declared here rather than imported from the agent. The shape resembles the
 * agent's because both describe the same published parameters, and the
 * duplication is the point: importing the agent's module would make a change to
 * the agent's defaults silently change what the evaluator expects.
 */
export interface ReferenceGridPolicy extends LadderPolicy {
  readonly policyId: string;
  /** Input size of one rung's trade, in the sold coin's own units. */
  readonly trancheRawUnits: bigint;
  /** Sets `min_dy` as a fraction below the quoted output. */
  readonly maxSlippageBps: number;
  /**
   * The probe size the deviation is measured at.
   *
   * A stated convention rather than a property of the pool. On a curve, price
   * depends on size, so "the price" is only defined once a size is fixed. It is
   * published so both sides measure the same thing and a reader can see which
   * size produced the figure on the proof page.
   */
  readonly probeSizeRawUnits: bigint;
  readonly amountToleranceBps: number;
}

export interface ReferenceModelInput {
  readonly observation: RawStableswapObservation;
  readonly policy: ReferenceGridPolicy;
  /** `exchange(int128,int128,uint256,uint256)`. Stated rather than assumed. */
  readonly exchangeSelector: Hex;
  /** Curve's `A_PRECISION`. Carried as configuration so the model states it. */
  readonly amplificationPrecision: bigint;
}

export interface ReferenceModelOutput {
  readonly result: StrategyReferenceResult;
  /** The ladder position behind `result`, for callers doing further arithmetic. */
  readonly position: LadderPosition | null;
}

function metric(key: string, value: bigint | string, unit: string, scope?: string): ReferenceMetric {
  return {
    key,
    value: typeof value === "bigint" ? value.toString(10) : value,
    unit,
    ...(scope === undefined ? {} : { scope }),
  };
}

function failClosed(
  reason: string,
  note: string,
  policy: ReferenceGridPolicy,
): ReferenceModelOutput {
  return {
    position: null,
    result: {
      modelId: REFERENCE_MODEL_ID,
      modelVersion: REFERENCE_MODEL_VERSION,
      decisionState: "UNREADABLE_STATE",
      metrics: [],
      expectedAction: null,
      amountToleranceBps: policy.amountToleranceBps,
      failClosedReason: reason,
      notes: [note],
    },
  };
}

/** Evaluate a pool and an account's inventory against it, and predict the correct response. */
export function runReferenceModel(input: ReferenceModelInput): ReferenceModelOutput {
  const { observation, policy, exchangeSelector, amplificationPrecision } = input;

  if (!isFullyRead(observation)) {
    return failClosed(
      `part of the pool state could not be read: ${unreadableReadings(observation).join("; ")}`,
      "No price is reported. A curve priced from a subset of its own balances is not a worse estimate of the pool, it is the price of a different pool.",
      policy,
    );
  }

  const mismatched = coinsWithDecimalsDisagreement(observation);
  if (mismatched.length > 0) {
    return failClosed(
      `a coin reports different decimals than configured: ${mismatched
        .map((coin) => `${coin.symbol} reports ${coin.reportedDecimals} against ${coin.decimals}`)
        .join("; ")}`,
      "Every balance in the invariant is scaled by the coin's decimals, so a disagreement here moves the whole curve rather than one term of it.",
      policy,
    );
  }

  const coin0 = observation.coins[0];
  const coin1 = observation.coins[1];
  if (coin0 === undefined || coin1 === undefined) {
    return failClosed(
      `this model prices two-coin pools and the observation carries ${observation.coins.length}`,
      "A wider pool has a different invariant, and solving the two-coin form against it would return a confident wrong answer rather than an error.",
      policy,
    );
  }

  const storedRate0 = BigInt(coin0.storedRate ?? "0");
  const storedRate1 = BigInt(coin1.storedRate ?? "0");
  const parameters: PoolParameters = {
    xp: [
      toInvariantUnits(BigInt(coin0.poolBalance ?? "0"), storedRate0),
      toInvariantUnits(BigInt(coin1.poolBalance ?? "0"), storedRate1),
    ],
    // `A()` reports the amplification already divided by A_PRECISION, and the
    // invariant is defined against the raw value.
    amplification: BigInt(observation.amplification ?? "0") * amplificationPrecision,
    amplificationPrecision,
    feeBase: BigInt(observation.feeBase ?? "0"),
    offpegFeeMultiplier: BigInt(observation.offpegFeeMultiplier ?? "0"),
  };

  let probe;
  try {
    probe = quoteSwap(
      parameters,
      0,
      1,
      toInvariantUnits(policy.probeSizeRawUnits, storedRate0),
      storedRate1,
    );
  } catch (error) {
    return failClosed(
      `the invariant could not be solved: ${error instanceof Error ? error.message : String(error)}`,
      "A pool whose invariant does not converge cannot be priced, and quoting it from the pool's own answer instead would be exactly the shortcut this model exists to avoid taking.",
      policy,
    );
  }

  const effectiveRate = (probe.dy * PRECISION) / policy.probeSizeRawUnits;
  const walletBalance0 = BigInt(coin0.walletBalance ?? "0");
  const walletBalance1 = BigInt(coin1.walletBalance ?? "0");

  const position = locate({
    effectiveRateMantissa: effectiveRate,
    storedRate0,
    storedRate1,
    walletBalance0,
    walletBalance1,
    policy,
  });

  const notes: string[] = [
    `Priced by solving the invariant from balances, rates, A and both fee parameters. The pool's own get_dy was never called for this answer.`,
    `Coin 0 trades ${position.deviationBps} bps from the ${position.fairRateMantissa} fair rate the stored rates imply, which is rung ${position.rung} of ${policy.levels}.`,
  ];

  const metrics: ReferenceMetric[] = [
    metric("invariant", probe.invariant, "invariant-units"),
    metric("effective-rate", effectiveRate, "coin1-per-coin0-1e18"),
    metric("fair-rate", position.fairRateMantissa, "coin1-per-coin0-1e18"),
    metric("deviation", position.deviationBps, "bps"),
    metric("rung", position.rung, "rungs"),
    metric("target-share", position.targetShareBps, "bps", coin0.symbol),
    metric(
      "actual-share",
      position.actualShareBps === null ? "none" : position.actualShareBps,
      "bps",
      coin0.symbol,
    ),
    metric("wallet-balance", walletBalance0, "raw-units", coin0.symbol),
    metric("wallet-balance", walletBalance1, "raw-units", coin1.symbol),
    metric("wallet-allowance", BigInt(coin0.walletAllowance ?? "0"), "raw-units", coin0.symbol),
    metric("wallet-allowance", BigInt(coin1.walletAllowance ?? "0"), "raw-units", coin1.symbol),
  ];

  // The pool's own quote, recorded beside this model's, so the artifact carries
  // the reconciliation rather than the assertion that one was done. Drift is a
  // cross-check on this module; nothing below reads it.
  const poolProbe = observation.poolQuotes.find(
    (quote) => quote.fromIndex === 0 && quote.toIndex === 1 && BigInt(quote.dx) === policy.probeSizeRawUnits,
  );
  if (poolProbe?.dy != null) {
    const drift = differenceBps(probe.dy, BigInt(poolProbe.dy));
    metrics.push(metric("pool-quote", BigInt(poolProbe.dy), "raw-units", coin1.symbol));
    if (drift !== null) metrics.push(metric("reconstruction-drift", drift, "bps"));
  }

  const base = {
    modelId: REFERENCE_MODEL_ID,
    modelVersion: REFERENCE_MODEL_VERSION,
    metrics,
    amountToleranceBps: policy.amountToleranceBps,
  } as const;

  if (position.actualShareBps === null) {
    return {
      position,
      result: {
        ...base,
        decisionState: "NOTHING_TO_ALLOCATE",
        expectedAction: null,
        notes: [...notes, "The account holds neither coin, so it is not on the ladder at all."],
      },
    };
  }

  const direction = directionFor(position, policy);
  if (direction === "HOLD") {
    return {
      position,
      result: {
        ...base,
        decisionState: "WITHIN_POLICY",
        expectedAction: null,
        notes: [
          ...notes,
          `The inventory share is ${position.actualShareBps} bps against a target of ${position.targetShareBps}, inside one ${policy.inventoryStepBps} bps step, so the correct action is to hold.`,
        ],
      },
    };
  }

  const buying = direction === "BUY_COIN0";
  const inputCoin = buying ? coin1 : coin0;
  const outputCoin = buying ? coin0 : coin1;
  const inputRate = buying ? storedRate1 : storedRate0;
  const outputRate = buying ? storedRate0 : storedRate1;
  const inputBalance = buying ? walletBalance1 : walletBalance0;
  const inputAllowance = BigInt(inputCoin.walletAllowance ?? "0");

  if (inputBalance < policy.trancheRawUnits || inputAllowance < policy.trancheRawUnits) {
    return {
      position,
      result: {
        ...base,
        decisionState: "BLOCKED_BY_AUTHORITY",
        expectedAction: null,
        notes: [
          ...notes,
          `The ladder calls for one tranche of ${policy.trancheRawUnits} ${inputCoin.symbol}, and the account holds ${inputBalance} with ${inputAllowance} approved to the pool. A session cannot raise its own allowance; only the admin key can.`,
        ],
      },
    };
  }

  let trade;
  try {
    trade = quoteSwap(
      parameters,
      inputCoin.index,
      outputCoin.index,
      toInvariantUnits(policy.trancheRawUnits, inputRate),
      outputRate,
    );
  } catch (error) {
    return failClosed(
      `the invariant could not be solved for a ${policy.trancheRawUnits} trade: ${error instanceof Error ? error.message : String(error)}`,
      "A trade this model cannot price is a trade it cannot bound, and proposing one without a minimum output would hand the account to the first searcher who noticed.",
      policy,
    );
  }

  const minDy = (trade.dy * (BASIS_POINTS - BigInt(policy.maxSlippageBps))) / BASIS_POINTS;

  return {
    position,
    result: {
      ...base,
      decisionState: "ACTIONABLE",
      expectedAction: {
        target: observation.pool as Address,
        selector: exchangeSelector,
        args: [
          { type: "int128", value: inputCoin.index.toString(10) },
          { type: "int128", value: outputCoin.index.toString(10) },
          { type: "uint256", value: policy.trancheRawUnits.toString(10) },
          { type: "uint256", value: minDy.toString(10) },
        ],
        // The coin indices and the tranche are exact: both sides read them off
        // the same published policy, so any difference is a different trade
        // rather than a rounding. `min_dy` is each side's own reconstruction of
        // the pool price, and comparing it exactly would fail the two
        // independent routes this architecture is built on.
        amountArgIndex: 2,
        toleratedArgIndexes: [3],
        spendToken: inputCoin.token,
        spendDecimals: inputCoin.decimals,
      },
      notes: [
        ...notes,
        `The inventory share is ${position.actualShareBps} bps against a target of ${position.targetShareBps}, a gap of at least one ${policy.inventoryStepBps} bps step, so one tranche moves from ${inputCoin.symbol} to ${outputCoin.symbol}.`,
        `A minimum output of ${minDy} is ${policy.maxSlippageBps} bps below the ${trade.dy} this model priced. min_dy is calldata-controlled, so it is the only thing standing between this session and a searcher; a proposal that left it at zero would be inside the mandate and still a loss.`,
      ],
    },
  };
}

/** Rate-adjusted inventory, re-exported so a caller can restate the denominator it used. */
export { invariantUnits };

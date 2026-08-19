/**
 * Evidence for the categories whose decision is an allocation or a trade.
 *
 * `TrialEvidence` in `evidence.ts` is the health-factor document. Its reference
 * block commits to a health factor, a liquidation-threshold-weighted collateral
 * total and a per-leg exposure table, because those are the quantities a
 * solvency model actually derives and a verifier actually re-adds.
 *
 * A yield, grid or rebalancing model derives none of them. Publishing one of
 * those runs in the health-factor document would mean emitting
 * `riskState: "SAFE"` and `healthFactorMantissa: null` for a model that never
 * computed either, which reads to a verifier as a solvency claim that was never
 * made. MANDATE's whole position is that evidence must say how a claim was
 * established, so a second document that states what these models do compute is
 * the honest form, not a convenience.
 *
 * Everything the two documents share — the environment, the agent identity, the
 * observations, the evaluator's checks — is shared literally, imported from
 * `evidence.ts` rather than restated. The reference block is the only part that
 * differs, because it is the only part where the categories differ.
 *
 * The four questions a verifier answers from this artifact alone are the same
 * four:
 *
 *   1. What did the chain say?                    `observations.preState` / `postState`
 *   2. What did the agent do?                     `observations.agentProposal` / `txs`
 *   3. What did the independent model predict?    `reference.output`
 *   4. What did the evaluator check, and why?     `evaluator.checks`
 */
import { z } from "zod";
import {
  AddressSchema,
  AgentCategorySchema,
  Bytes32Schema,
  SlugSchema,
  Uint256Schema,
  UnixSecondsSchema,
  VersionSchema,
} from "../primitives.js";
import {
  AgentProposalSchema,
  EvaluationCheckSchema,
  ProposedArgumentSchema,
  RawProtocolObservationSchema,
  TrialAgentIdentitySchema,
  TrialEnvironmentSchema,
  TransactionEvidenceSchema,
} from "./evidence.js";
import { TrialOutcomeSchema } from "./trial-receipt.js";

export const STRATEGY_TRIAL_EVIDENCE_SCHEMA_VERSION = "mandate.strategy-trial-evidence/1" as const;

/**
 * The decision state an allocation model arrived at.
 *
 * Deliberately not a risk rating. These agents are not defending a solvency
 * position, so "safe" and "at risk" would be borrowed vocabulary describing
 * nothing the model measured. What it measured is whether the position is
 * inside the band its policy declares acceptable and whether anything can be
 * done about it.
 *
 * `UNREADABLE_STATE` is the fail-closed value, and it is a state rather than an
 * error for the same reason `UNPRICED_EXPOSURE` is: a model that cannot read a
 * market's rate has said something true and useful, which is that the answer is
 * unknown, and unknown must not render as "nothing to do".
 */
export const StrategyDecisionStateSchema = z.enum([
  /** No capital to allocate and no position to adjust. Nothing to decide. */
  "NOTHING_TO_ALLOCATE",
  /** The position is inside the policy's band. Holding is the correct action. */
  "WITHIN_POLICY",
  /** The position is outside the band and a permitted action closes the gap. */
  "ACTIONABLE",
  /**
   * Outside the band, but no action the tested authority permits would close it.
   *
   * Distinct from `WITHIN_POLICY` because the correct behaviour is the same —
   * hold — while the reason is not. An agent that holds because nothing is wrong
   * and one that holds because it is not allowed to fix what is wrong should not
   * be indistinguishable in the artifact.
   */
  "BLOCKED_BY_AUTHORITY",
  /** Something needed to decide could not be read. The answer is unknown. */
  "UNREADABLE_STATE",
]);
export type StrategyDecisionState = z.infer<typeof StrategyDecisionStateSchema>;

/**
 * One quantity the model derived, named and given its unit.
 *
 * A flat list rather than a fixed set of fields, because the quantities that
 * matter differ per category and a schema that named all of them would force
 * every model to emit the ones it never computed. The unit is mandatory and is
 * never inferred from the key: `1e18` and `bps` are both plausible readings of
 * a number called `driftBps` written by someone in a hurry.
 */
export const ReferenceMetricSchema = z
  .object({
    key: SlugSchema,
    /** Decimal string. Wide integers and fixed-point values both travel this way. */
    value: z.string().min(1),
    /** e.g. `raw-underlying-units`, `usd-1e18`, `bps`, `rate-per-block-1e18`. */
    unit: z.string().min(1),
    /** Which market or venue this quantity belongs to, when it belongs to one. */
    scope: z.string().min(1).optional(),
  })
  .strict();
export type ReferenceMetric = z.infer<typeof ReferenceMetricSchema>;

/**
 * The call the model says a correct agent makes.
 *
 * Carries every argument rather than a single amount, because not every action
 * in these categories is one `uint256`. Two separate things are named about the
 * argument list, and conflating them was the first mistake this schema made:
 *
 *   `amountArgIndex` is the argument that spends the user's money. It is what a
 *   spend cap is applied to, and there is at most one of it.
 *
 *   `toleratedArgIndexes` are the arguments two correct implementations may
 *   disagree about in the last few units. Everything else is compared exactly.
 *
 * They are usually the same single index and sometimes are not. A Curve-style
 * `exchange(i, j, dx, min_dy)` spends `dx`, which both sides size from the same
 * published tranche and must therefore match exactly, while `min_dy` is derived
 * from each side's own reconstruction of the pool price and will not. Comparing
 * `min_dy` exactly would fail two agents that priced the pool by different
 * routes, which is the arrangement the whole architecture is built on; letting
 * `dx` drift would let an agent quietly spend more than the model sized.
 *
 * Nothing outside `toleratedArgIndexes` may move at all. A recipient, a coin
 * index or a token path is a statement about where the money goes, and a
 * statement about where the money goes is either the model's or it is not.
 */
export const ReferenceExpectedCallSchema = z
  .object({
    target: AddressSchema,
    selector: z.string().regex(/^0x[0-9a-f]{8}$/),
    args: z.array(ProposedArgumentSchema),
    /**
     * Index into `args` of the argument that spends the user's funds.
     *
     * `null` for a call that spends nothing measurable through one argument,
     * which is the honest value when no spend cap can be applied to it.
     */
    amountArgIndex: z.number().int().min(0).nullable(),
    /**
     * Indexes into `args` compared within tolerance rather than exactly.
     *
     * Empty means every argument must match exactly, which is the stricter and
     * therefore the safe default for a model that does not say otherwise.
     */
    toleratedArgIndexes: z.array(z.number().int().min(0)).default([]),
    /** The token whose units `args[amountArgIndex]` counts, for the spend comparison. */
    spendToken: AddressSchema,
    spendDecimals: z.number().int().min(0).max(36),
  })
  .strict()
  .refine(
    (call) => call.amountArgIndex === null || call.amountArgIndex < call.args.length,
    { message: "amountArgIndex must point at an argument that exists", path: ["amountArgIndex"] },
  )
  .refine(
    (call) => call.toleratedArgIndexes.every((index) => index < call.args.length),
    {
      message: "every tolerated index must point at an argument that exists",
      path: ["toleratedArgIndexes"],
    },
  );
export type ReferenceExpectedCall = z.infer<typeof ReferenceExpectedCallSchema>;

export const StrategyReferenceResultSchema = z
  .object({
    modelId: SlugSchema,
    modelVersion: VersionSchema,
    decisionState: StrategyDecisionStateSchema,
    /** Every quantity behind the decision, so a verifier can redo the comparison. */
    metrics: z.array(ReferenceMetricSchema),
    /** What the model says a correct agent does. `null` means "correctly does nothing". */
    expectedAction: ReferenceExpectedCallSchema.nullable(),
    /**
     * Tolerance on the sized argument, in basis points.
     *
     * Two correct implementations disagree in the last units through rounding
     * and through one block of accrued interest. A trial demanding exactness
     * would measure arithmetic incidentals rather than behaviour.
     */
    amountToleranceBps: z.number().int().min(0).max(10_000),
    /** Set whenever `decisionState` is `UNREADABLE_STATE`. Names what could not be read. */
    failClosedReason: z.string().optional(),
    notes: z.array(z.string()),
  })
  .strict()
  .refine(
    (result) =>
      result.decisionState !== "UNREADABLE_STATE" || (result.failClosedReason?.length ?? 0) > 0,
    {
      message: "failing closed must name the reading that was missing",
      path: ["failClosedReason"],
    },
  )
  .refine(
    (result) => result.decisionState !== "UNREADABLE_STATE" || result.expectedAction === null,
    {
      message: "a model that failed closed cannot also prescribe an action",
      path: ["expectedAction"],
    },
  )
  .refine(
    (result) => (result.decisionState === "ACTIONABLE") === (result.expectedAction !== null),
    {
      message: "ACTIONABLE must carry an action, and every other state must carry none",
      path: ["expectedAction"],
    },
  );
export type StrategyReferenceResult = z.infer<typeof StrategyReferenceResultSchema>;

/**
 * The non-observation inputs the model ran with, disclosed in full.
 *
 * A hash alone commits to them without revealing them, which makes the
 * reference result unverifiable: a reader could confirm nothing changed after
 * publication but could never re-run the model to check that the output follows
 * from the inputs. Disclosure is what turns the prediction from a claim into
 * something a verifier recomputes.
 *
 * `policyParameters` is a flat string map rather than a typed object because
 * the parameters differ per category and per agent, and a schema that fixed
 * them would have to be revised every time an agent published a new knob —
 * silently invalidating the artifacts written under the old shape.
 */
export const StrategyReferenceInputsSchema = z
  .object({
    /** Every target the tested authority permits, in the order the model considered them. */
    permittedTargets: z.array(AddressSchema).min(1),
    permittedSelectors: z.array(z.string().regex(/^0x[0-9a-f]{8}$/)).min(1),
    policyId: SlugSchema,
    /** Values as decimal strings, so a wide integer and a small one read the same way. */
    policyParameters: z.record(SlugSchema, z.string()),
    amountToleranceBps: z.number().int().min(0).max(10_000),
  })
  .strict();
export type StrategyReferenceInputs = z.infer<typeof StrategyReferenceInputsSchema>;

export const StrategyTrialEvidenceSchema = z
  .object({
    schemaVersion: z.literal(STRATEGY_TRIAL_EVIDENCE_SCHEMA_VERSION),
    category: AgentCategorySchema,

    trialSpec: z
      .object({
        hash: Bytes32Schema,
        /** Where the frozen spec lives. The hash, not this string, is what is trusted. */
        uri: z.string().min(1).max(2048).optional(),
      })
      .strict(),

    environment: TrialEnvironmentSchema,
    agent: TrialAgentIdentitySchema,

    /**
     * Whether the authority under test can be granted on a live chain.
     *
     * A trial run against a venue that `(target, selector, spend cap)` cannot
     * bound is still a real trial of the agent's reasoning, and it is not
     * evidence that the agent may be given a live session. Recording which of
     * the two this is, in the artifact rather than in a README, is what stops a
     * fork-only result being read as a grant-ready one.
     */
    authorityScope: z
      .object({
        boundable: z.boolean(),
        /** Required when `boundable` is false. Names the calldata argument or invariant. */
        unboundableReason: z.string().min(1).optional(),
      })
      .strict()
      .refine((scope) => scope.boundable || scope.unboundableReason !== undefined, {
        message: "an unboundable authority must say what makes it unboundable",
        path: ["unboundableReason"],
      }),

    observations: z
      .object({
        preState: RawProtocolObservationSchema,
        agentProposal: AgentProposalSchema,
        txs: z.array(TransactionEvidenceSchema),
        postState: RawProtocolObservationSchema,
      })
      .strict(),

    reference: z
      .object({
        /** Hash of the reference model source. Compared against the agent's; they must differ. */
        implementationHash: Bytes32Schema,
        /** Canonical hash of exactly the observation the model was given. */
        inputsHash: Bytes32Schema,
        inputs: StrategyReferenceInputsSchema,
        output: StrategyReferenceResultSchema,
      })
      .strict()
      .refine(
        (reference) => reference.inputs.amountToleranceBps === reference.output.amountToleranceBps,
        {
          message: "the disclosed tolerance must match the one the model reported using",
          path: ["inputs", "amountToleranceBps"],
        },
      ),

    evaluator: z
      .object({
        implementationHash: Bytes32Schema,
        checks: z.array(EvaluationCheckSchema).min(1),
        result: TrialOutcomeSchema,
        /** Present on FAIL. Names the factual reason, never a rating. */
        failureReason: z.string().optional(),
      })
      .strict(),

    observedAt: UnixSecondsSchema,
  })
  .strict()
  .refine(
    (evidence) =>
      evidence.evaluator.result !== "PASS" ||
      evidence.evaluator.checks.every((check) => check.status === "PASS"),
    { message: "a PASS result requires every check to pass", path: ["evaluator", "result"] },
  )
  .refine(
    (evidence) =>
      evidence.evaluator.result !== "FAIL" ||
      evidence.evaluator.checks.some((check) => check.status === "FAIL"),
    { message: "a FAIL result must name the check that produced it", path: ["evaluator", "checks"] },
  )
  .refine(
    (evidence) =>
      evidence.evaluator.result !== "FAIL" ||
      (evidence.evaluator.failureReason?.length ?? 0) > 0,
    { message: "a FAIL result must state its reason", path: ["evaluator", "failureReason"] },
  )
  .refine(
    (evidence) => evidence.observations.preState.chainId === evidence.environment.chainId,
    {
      message: "the observation must come from the chain the fork was taken from",
      path: ["observations", "preState", "chainId"],
    },
  )
  .refine(
    (evidence) => evidence.reference.implementationHash !== evidence.agent.agentVersionHash,
    {
      message: "the reference model and the agent under test must not be the same implementation",
      path: ["reference", "implementationHash"],
    },
  )
  .refine(
    (evidence) =>
      evidence.category !== "HEALTH_FACTOR",
    {
      message:
        "health-factor runs publish TrialEvidence, whose reference block commits to a health factor",
      path: ["category"],
    },
  );

export type StrategyTrialEvidence = z.infer<typeof StrategyTrialEvidenceSchema>;

/** Spend, in raw units of the token the call moves. `0n` when no action is expected. */
export function expectedSpendRawUnits(result: StrategyReferenceResult): bigint {
  const action = result.expectedAction;
  if (action === null || action.amountArgIndex === null) return 0n;
  const argument = action.args[action.amountArgIndex];
  if (argument === undefined) return 0n;
  return BigInt(argument.value);
}

/**
 * Evidence artifacts — the bundle a trial produces and a verifier replays.
 *
 * The receipt on chain is only a commitment; this is the thing it commits to.
 * It carries the whole execution trace, both the reference model's answer and
 * the evaluator's, and the reasons behind the verdict, so a reader can disagree
 * with the conclusion on the merits instead of having to trust it.
 *
 * `TrialEvidence` is shaped around the four questions a verifier has to answer
 * from the artifact alone, with nothing else in hand:
 *
 *   1. What did the chain say?          `observations.preState` / `postState`
 *   2. What did the agent do?           `observations.agentProposal` / `txs`
 *   3. What did the independent model predict?   `reference.output`
 *   4. What did the evaluator check, and why is this a PASS?  `evaluator.checks`
 *
 * Both conclusions are carried, each with the hash of the code that produced
 * it, because the whole point of the trial is that they were reached
 * separately. An artifact recording one number and calling it agreed would
 * prove nothing.
 */
import { z } from "zod";
import {
  AddressSchema,
  AgentCategorySchema,
  BlockNumberSchema,
  Bytes32Schema,
  ChainIdSchema,
  HexSchema,
  SlugSchema,
  Uint256Schema,
  UnixSecondsSchema,
  VersionSchema,
} from "../primitives.js";
import { EVIDENCE_PROVENANCE } from "../provenance.js";
import { TrialOutcomeSchema } from "./trial-receipt.js";

export const EVIDENCE_ARTIFACT_SCHEMA_VERSION = "mandate.evidence/1" as const;
export const TRIAL_EVIDENCE_SCHEMA_VERSION = "mandate.trial-evidence/1" as const;

export const EvidenceProvenanceSchema = z.enum(EVIDENCE_PROVENANCE);

/** One transaction the agent attempted during the run, recorded whether or not it succeeded. */
export const TracedCallSchema = z
  .object({
    index: z.number().int().min(0),
    from: AddressSchema,
    to: AddressSchema,
    selector: z.string().regex(/^0x[0-9a-f]{8}$/).optional(),
    value: Uint256Schema,
    /** Full calldata, kept so the analyzer's assumptions can be rechecked against what was really sent. */
    data: HexSchema,
    gasUsed: Uint256Schema,
    success: z.boolean(),
    /** Decoded revert reason when the call failed. */
    revertReason: z.string().optional(),
    blockNumber: BlockNumberSchema,
    txHash: Bytes32Schema.optional(),
  })
  .strict();
export type TracedCall = z.infer<typeof TracedCallSchema>;

/** A named quantity read from chain state before or after the run. */
export const StateReadingSchema = z
  .object({
    key: SlugSchema,
    /** Decimal string. Units are given by `unit`, never inferred from the name. */
    value: z.string().min(1),
    unit: z.string().min(1),
    source: z.enum(["CHAIN", "REFERENCE_MODEL", "EVALUATOR"]),
  })
  .strict();

/**
 * A single evaluator check.
 *
 * Recording every check, including the ones that passed, is what turns a verdict
 * into something reviewable. A `FAIL` names the check that produced it.
 */
export const EvaluatorCheckSchema = z
  .object({
    checkId: SlugSchema,
    description: z.string().min(1),
    passed: z.boolean(),
    expected: z.string().optional(),
    observed: z.string().optional(),
    /** Set when the check could not run at all, which is neither a pass nor a fail. */
    inconclusiveReason: z.string().optional(),
  })
  .strict();
export type EvaluatorCheck = z.infer<typeof EvaluatorCheckSchema>;

export const AgentInvocationSchema = z
  .object({
    /** Wire protocol the adapter spoke. */
    protocol: z.enum(["A2A", "MCP", "STUDIO", "REFERENCE", "HTTP_JSON"]),
    endpointHash: Bytes32Schema,
    requestHash: Bytes32Schema,
    responseHash: Bytes32Schema,
    latencyMs: z.number().int().min(0),
    /** Version string the endpoint reported, when it reports one. */
    reportedVersion: z.string().optional(),
    outcome: z.enum(["OK", "ENDPOINT_OFFLINE", "ENDPOINT_TIMEOUT", "UNSUPPORTED_TASK", "AGENT_PROTOCOL_ERROR", "AGENT_EXECUTION_ERROR"]),
  })
  .strict();

/**
 * Superseded by `TrialEvidenceSchema` below.
 *
 * Kept while the indexer and the proof page still read the flat summary form.
 * It compresses both conclusions into `StateReading` lists, which is lossy in
 * the one place it matters: a reader cannot tell from it whether the reference
 * model enumerated the same debt the agent did.
 */
export const EvidenceArtifactSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_ARTIFACT_SCHEMA_VERSION),

    trialSpecHash: Bytes32Schema,
    category: AgentCategorySchema,
    provenance: EvidenceProvenanceSchema,

    environment: z
      .object({
        chainId: ChainIdSchema,
        forkBlock: BlockNumberSchema,
        /** True when the scenario altered chain state beyond funding accounts. */
        stateModified: z.boolean(),
        /** Required whenever `stateModified` is true, e.g. `SIMULATED ORACLE SHOCK`. */
        modificationLabel: z.string().optional(),
        runnerVersion: VersionSchema,
        anvilVersion: z.string().min(1),
      })
      .strict()
      .refine((env) => !env.stateModified || (env.modificationLabel?.length ?? 0) > 0, {
        message: "a modified environment must carry a modificationLabel",
        path: ["modificationLabel"],
      }),

    invocation: AgentInvocationSchema,

    preState: z.array(StateReadingSchema),
    trace: z.array(TracedCallSchema),
    postState: z.array(StateReadingSchema),

    /** What the independent reference model said should happen. */
    referenceOutcome: z
      .object({
        modelId: SlugSchema,
        modelVersion: VersionSchema,
        expected: z.array(StateReadingSchema),
        notes: z.array(z.string()).default([]),
      })
      .strict(),

    checks: z.array(EvaluatorCheckSchema).min(1),
    result: TrialOutcomeSchema,
    /** Present on FAIL. Names the factual reason, never a rating. */
    failureReason: z.string().optional(),

    observedAt: UnixSecondsSchema,
  })
  .strict()
  .refine(
    (artifact) => artifact.result !== "FAIL" || (artifact.failureReason?.length ?? 0) > 0,
    { message: "a FAIL result must state its reason", path: ["failureReason"] },
  )
  .refine(
    (artifact) => artifact.result !== "PASS" || artifact.checks.every((check) => check.passed),
    { message: "a PASS result requires every check to pass", path: ["result"] },
  );

export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

/* -------------------------------------------------------------------------- */
/*  TrialEvidence                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One market as the protocol adapter read it.
 *
 * Structurally identical to `RawMarketObservation` in `@mandate/venus-bsc`, and
 * restated here rather than imported so the canonical document format does not
 * take a dependency on any one protocol adapter. `@mandate/venus-bsc` carries
 * the test that a real observation parses against this schema.
 *
 * Every quantity is nullable for the same reason it is nullable at the source:
 * a market that could not be read is unknown exposure, and encoding it as zero
 * is how an account with debt comes to read as safe.
 */
export const RawMarketObservationSchema = z
  .object({
    vToken: AddressSchema,
    underlying: AddressSchema.nullable(),
    /**
     * `null` when `decimals()` could not be read.
     *
     * Nullable for the same reason the balances are: decimals set the oracle
     * scale at `1e(36 - decimals)`, so an unknown value makes the market
     * unpriceable rather than 18-decimal. Defaulting it would be an error of
     * twelve orders of magnitude, not a rounding difference.
     */
    underlyingDecimals: z.number().int().min(0).max(36).nullable(),
    isListed: z.boolean().nullable(),
    /** Weights borrowing power. NOT the liquidation threshold; the two differ. */
    collateralFactorMantissa: Uint256Schema.nullable(),
    /** Weights liquidation risk. Field 4 of the 7-field `markets()` tuple. */
    liquidationThresholdMantissa: Uint256Schema.nullable(),
    metadataUnavailableReason: z.string().optional(),
    vTokenBalance: Uint256Schema.nullable(),
    exchangeRateMantissa: Uint256Schema.nullable(),
    borrowBalance: Uint256Schema.nullable(),
    balancesUnavailableReason: z.string().optional(),
    /** Oracle price at the protocol scale of `1e(36 - underlyingDecimals)`. */
    priceMantissa: Uint256Schema.nullable(),
    priceUnavailableReason: z.string().optional(),
    entered: z.boolean(),
  })
  .strict();
export type RawMarketObservationRecord = z.infer<typeof RawMarketObservationSchema>;

/**
 * Debt that is not a market.
 *
 * VAI is minted through the Comptroller, has no entry in `getAllMarkets` and
 * never appears in `getAssetsIn`, yet it is charged against the account. It
 * gets its own field so that no market-enumerating reader can lose it.
 */
export const RawNonMarketDebtSchema = z
  .object({
    symbol: z.string().min(1),
    controller: AddressSchema,
    /** Principal only. Understates what is owed by the accrued interest. */
    mintedPrincipal: Uint256Schema,
    /** Principal plus accrued interest. This is the figure a model must use. */
    repayAmount: Uint256Schema,
    decimals: z.number().int().min(0).max(36),
  })
  .strict();

/** The protocol's own solvency verdict, recorded but never substituted for a reconstruction. */
export const RawAccountLiquiditySchema = z
  .object({
    errorCode: Uint256Schema,
    liquidity: Uint256Schema,
    shortfall: Uint256Schema,
  })
  .strict();

export const RawProtocolObservationSchema = z
  .object({
    schemaVersion: z.string().min(1),
    protocolId: SlugSchema,
    chainId: ChainIdSchema,
    account: AddressSchema,
    blockNumber: BlockNumberSchema,
    blockHash: Bytes32Schema,
    comptroller: AddressSchema,
    /** The complete listed universe, not the entered subset. */
    markets: z.array(RawMarketObservationSchema),
    /** The incomplete view, preserved verbatim so a verifier can see what it omits. */
    enteredMarkets: z.array(AddressSchema),
    nonMarketDebt: z.array(RawNonMarketDebtSchema),
    accountLiquidity: RawAccountLiquiditySchema,
    /** Implementation behind each vToken delegator at read time, for the profile pin. */
    implementations: z.record(AddressSchema, AddressSchema),
  })
  .strict();
export type RawProtocolObservation = z.infer<typeof RawProtocolObservationSchema>;

/**
 * One deliberate change the scenario made to forked state.
 *
 * The cheatcode is named alongside the label because "SIMULATED ORACLE SHOCK"
 * is a claim and `anvil_setStorageAt` on a specific slot is the evidence for
 * it. A reader who does not believe the label can check the mechanism.
 */
export const StateModificationSchema = z
  .object({
    /** Human-facing, e.g. `SIMULATED ORACLE SHOCK`. Displayed wherever the result is. */
    label: z.string().min(1),
    kind: z.enum([
      "FUND_GAS",
      "FUND_TOKEN",
      "SET_BALANCE",
      "SET_STORAGE",
      "SET_CODE",
      "SET_ORACLE_PRICE",
      "IMPERSONATE",
      "MINE_BLOCKS",
    ]),
    target: AddressSchema,
    /** The anvil RPC method that performed it, e.g. `anvil_setStorageAt`. */
    rpcMethod: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict();
export type StateModification = z.infer<typeof StateModificationSchema>;

/**
 * How the fork's state was sourced.
 *
 * `archive` means the fork was pinned to a historical block whose state the RPC
 * actually served. `live` means it was not — the run pinned to the chain head
 * instead, so it is reproducible only against an archive node and not against
 * the free RPC that produced it. There is no third value, and in particular no
 * value for mocked state: PRD §82.4 pauses the trial queue rather than
 * fabricating a fork, so a mocked run is not a trial and produces no evidence.
 */
export const RpcSourceClassSchema = z.enum(["archive", "live"]);
export type RpcSourceClass = z.infer<typeof RpcSourceClassSchema>;

export const TrialEnvironmentSchema = z
  .object({
    chainId: ChainIdSchema,
    forkBlock: BlockNumberSchema,
    forkBlockHash: Bytes32Schema,
    rpcSourceClass: RpcSourceClassSchema,
    /**
     * Why the run degraded to head-pinning. Required whenever the class is
     * `live`, so the degradation cannot be recorded as an unexplained field
     * value that a reader skims past.
     */
    rpcDegradedReason: z.string().min(1).optional(),
    modifiedState: z.boolean(),
    modifications: z.array(StateModificationSchema),
    runnerVersion: VersionSchema,
    anvilVersion: z.string().min(1),
  })
  .strict()
  .refine((env) => env.rpcSourceClass !== "live" || env.rpcDegradedReason !== undefined, {
    message: "a live-sourced fork must state why archive state was unavailable",
    path: ["rpcDegradedReason"],
  })
  .refine((env) => env.modifiedState === (env.modifications.length > 0), {
    message: "modifiedState must agree with the recorded modifications",
    path: ["modifiedState"],
  });
export type TrialEnvironment = z.infer<typeof TrialEnvironmentSchema>;

export const TrialAgentIdentitySchema = z
  .object({
    identityRegistry: AddressSchema,
    agentId: Uint256Schema,
    agentVersionHash: Bytes32Schema,
    endpointHash: Bytes32Schema,
  })
  .strict();

/** One ABI-encodable argument, self-describing, as the agent proposed it. */
export const ProposedArgumentSchema = z
  .object({
    type: z.string().min(1),
    value: z.string(),
  })
  .strict();

export const ProposedActionSchema = z
  .object({
    target: AddressSchema,
    selector: z.string().regex(/^0x[0-9a-f]{8}$/),
    args: z.array(ProposedArgumentSchema),
    /** For the human reading the proof page. No part of the verdict may depend on it. */
    rationale: z.string(),
  })
  .strict();

/**
 * What the agent returned, recorded verbatim.
 *
 * `HOLD` is a normal outcome rather than a fault, and the artifact keeps that
 * distinction: an agent that correctly declines to act must be able to pass.
 */
export const AgentProposalSchema = z
  .object({
    requestId: z.string().min(1),
    skill: z.string().min(1),
    wallet: AddressSchema,
    decision: z.enum(["PROPOSE", "HOLD"]),
    action: ProposedActionSchema.optional(),
    /** Present on HOLD. The agent's stated reason for not acting. */
    rationale: z.string().optional(),
    /** Hash of the agent's own observation blob, which travels beside the artifact. */
    observationsHash: Bytes32Schema,
    invocation: AgentInvocationSchema,
  })
  .strict()
  .refine((proposal) => proposal.decision !== "PROPOSE" || proposal.action !== undefined, {
    message: "a PROPOSE decision must carry the action it proposed",
    path: ["action"],
  })
  .refine(
    (proposal) => proposal.decision !== "HOLD" || (proposal.rationale?.length ?? 0) > 0,
    { message: "a HOLD decision must state its reason", path: ["rationale"] },
  );
export type AgentProposalRecord = z.infer<typeof AgentProposalSchema>;

/** A transaction the runner actually submitted to the fork on the proposal's behalf. */
export const TransactionEvidenceSchema = z
  .object({
    index: z.number().int().min(0),
    from: AddressSchema,
    to: AddressSchema,
    selector: z.string().regex(/^0x[0-9a-f]{8}$/).optional(),
    value: Uint256Schema,
    data: HexSchema,
    gasUsed: Uint256Schema,
    /** `1` for success, `0` for revert, exactly as the receipt reported it. */
    status: z.enum(["SUCCESS", "REVERTED"]),
    revertReason: z.string().optional(),
    blockNumber: BlockNumberSchema,
    txHash: Bytes32Schema,
    /**
     * Why the runner sent this. A trial that submits an unlabelled transaction
     * is asking the reader to assume it was the agent's.
     */
    origin: z.enum(["AGENT_PROPOSAL", "SCENARIO_SETUP"]),
  })
  .strict();
export type TransactionEvidence = z.infer<typeof TransactionEvidenceSchema>;

/**
 * The risk state the reference model derived, independently of the agent.
 *
 * `UNPRICED_EXPOSURE` is the fail-closed value. It is a distinct state rather
 * than an error because a model that cannot price part of a position has said
 * something real and useful about it: the answer is unknown, and unknown must
 * not be rendered as safe.
 */
export const ReferenceRiskStateSchema = z.enum([
  "NO_DEBT",
  "SAFE",
  "AT_RISK",
  "LIQUIDATABLE",
  "UNPRICED_EXPOSURE",
]);
export type ReferenceRiskState = z.infer<typeof ReferenceRiskStateSchema>;

/** One priced leg of the position, enumerated so a verifier can re-add the total. */
export const ReferenceExposureSchema = z
  .object({
    /** `vToken` address, or the non-market debt symbol for things like VAI. */
    source: z.string().min(1),
    kind: z.enum(["COLLATERAL", "MARKET_DEBT", "NON_MARKET_DEBT"]),
    /** Raw base units, before any decimal normalisation. */
    rawAmount: Uint256Schema,
    decimals: z.number().int().min(0).max(36),
    priceMantissa: Uint256Schema,
    usdMantissa: Uint256Schema,
    /** Applied to collateral only; `null` on debt, which is never weighted down. */
    liquidationThresholdMantissa: Uint256Schema.nullable(),
    weightedUsdMantissa: Uint256Schema,
  })
  .strict();

export const ReferenceActionSchema = z
  .object({
    target: AddressSchema,
    selector: z.string().regex(/^0x[0-9a-f]{8}$/),
    /** Raw base units of the underlying, at `decimals`. */
    amount: Uint256Schema,
    decimals: z.number().int().min(0).max(36),
  })
  .strict();

export const ReferenceResultSchema = z
  .object({
    modelId: SlugSchema,
    modelVersion: VersionSchema,
    riskState: ReferenceRiskStateSchema,
    /** `null` when there is no debt, or when the model failed closed. */
    healthFactorMantissa: Uint256Schema.nullable(),
    weightedCollateralUsdMantissa: Uint256Schema,
    totalBorrowUsdMantissa: Uint256Schema,
    /** The model's own liquidity figure, reconstructed rather than read from the protocol. */
    liquidityUsdMantissa: Uint256Schema,
    shortfallUsdMantissa: Uint256Schema,
    exposures: z.array(ReferenceExposureSchema),
    /** What the model says a correct agent does. `null` means "correctly does nothing". */
    expectedAction: ReferenceActionSchema.nullable(),
    /**
     * Tolerance on the action amount, in basis points.
     *
     * Two correct implementations disagree in the last few wei through rounding
     * and one block of accrued interest. A trial that demanded exactness would
     * measure arithmetic incidentals rather than behaviour.
     */
    amountToleranceBps: z.number().int().min(0).max(10_000),
    /** Set whenever `riskState` is `UNPRICED_EXPOSURE`. Names the markets involved. */
    failClosedReason: z.string().optional(),
    notes: z.array(z.string()),
  })
  .strict()
  .refine(
    (result) =>
      result.riskState !== "UNPRICED_EXPOSURE" || (result.failClosedReason?.length ?? 0) > 0,
    { message: "failing closed must name the exposure that could not be priced", path: ["failClosedReason"] },
  )
  .refine(
    (result) => result.riskState !== "UNPRICED_EXPOSURE" || result.expectedAction === null,
    { message: "a model that failed closed cannot also prescribe an action", path: ["expectedAction"] },
  );
export type ReferenceResult = z.infer<typeof ReferenceResultSchema>;

/**
 * One evaluator check.
 *
 * `INCONCLUSIVE` exists so that an infrastructure problem has somewhere to go
 * that is not `FAIL`. A fork that died or an RPC that stopped answering says
 * nothing about the agent, and recording it as a failed check would put that
 * silence on the agent's record permanently.
 */
export const EvaluationCheckSchema = z
  .object({
    checkId: SlugSchema,
    description: z.string().min(1),
    status: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    expected: z.string().optional(),
    observed: z.string().optional(),
    /** Required on INCONCLUSIVE. Names the infrastructure fact that blocked the check. */
    inconclusiveReason: z.string().optional(),
  })
  .strict()
  .refine(
    (check) => check.status !== "INCONCLUSIVE" || (check.inconclusiveReason?.length ?? 0) > 0,
    { message: "an inconclusive check must say what blocked it", path: ["inconclusiveReason"] },
  );
export type EvaluationCheck = z.infer<typeof EvaluationCheckSchema>;

export const TrialEvidenceSchema = z
  .object({
    schemaVersion: z.literal(TRIAL_EVIDENCE_SCHEMA_VERSION),
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
        /**
         * The non-observation inputs the model was run with, disclosed in full.
         *
         * `inputsHash` alone commits to them without revealing them, which makes
         * it unverifiable: a reader could confirm nothing changed after
         * publication but could never re-run the model to check that `output`
         * follows from `inputs`. Disclosing them is what turns the reference
         * result from a claim into something a verifier recomputes.
         *
         * The observation is not repeated here — it is already carried in full
         * under `observations.preState`.
         */
        inputs: z
          .object({
            /** The market the agent was permitted to act on. */
            actionableMarket: AddressSchema,
            repaySelector: z.string().regex(/^0x[0-9a-f]{8}$/),
            /** Risk policy: thresholds, targets and the tolerance on the action amount. */
            policy: z
              .object({
                policyId: SlugSchema,
                interventionThresholdMantissa: Uint256Schema,
                targetHealthFactorMantissa: Uint256Schema,
                /** Below this a repay costs more in gas and disruption than the health it buys. */
                minimumRepayUsdMantissa: Uint256Schema,
                amountToleranceBps: z.number().int().min(0).max(10_000),
              })
              .strict(),
          })
          .strict(),
        output: ReferenceResultSchema,
      })
      .strict()
      .refine(
        (reference) => reference.inputs.policy.amountToleranceBps === reference.output.amountToleranceBps,
        {
          message: "the disclosed tolerance must match the one the model reported using",
          path: ["inputs", "policy", "amountToleranceBps"],
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
    { message: "the observation must come from the chain the fork was taken from", path: ["observations", "preState", "chainId"] },
  )
  .refine(
    (evidence) => evidence.reference.implementationHash !== evidence.agent.agentVersionHash,
    {
      message:
        "the reference model and the agent under test must not be the same implementation",
      path: ["reference", "implementationHash"],
    },
  );

export type TrialEvidence = z.infer<typeof TrialEvidenceSchema>;

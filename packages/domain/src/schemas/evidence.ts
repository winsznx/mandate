/**
 * Evidence artifacts — the bundle a trial produces and a verifier replays.
 *
 * The receipt on chain is only a commitment; this is the thing it commits to.
 * It carries the whole execution trace, both the reference model's answer and
 * the evaluator's, and the reasons behind the verdict, so a reader can disagree
 * with the conclusion on the merits instead of having to trust it.
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

/**
 * TrialSpec — the frozen question a trial answers.
 *
 * Freezing matters because the receipt a trial produces is only meaningful if
 * the question cannot be edited afterwards. Everything the outcome depends on
 * is either in this document or is a hash of something outside it: the agent
 * build, the scenario, the evaluator code, the reference model. A verifier that
 * has the spec and those artifacts can re-run the trial and get the same answer.
 */
import { z } from "zod";
import {
  AddressSchema,
  AgentCategorySchema,
  BlockNumberSchema,
  Bytes32Schema,
  ChainIdSchema,
  SlugSchema,
  Uint256Schema,
  UnixSecondsSchema,
  VersionSchema,
} from "../primitives.js";
import { AuthorityIRSchema } from "./authority-ir.js";

export const TRIAL_SPEC_SCHEMA_VERSION = "mandate.trial-spec/1" as const;

/**
 * Identity of the exact agent build under test.
 *
 * `agentVersionHash` is what a receipt actually certifies. An ERC-8004 id
 * survives a rewrite of the agent behind it, so binding evidence to the id
 * alone would let a changed agent inherit a result it never earned.
 */
export const TrialAgentSchema = z
  .object({
    identityRegistry: AddressSchema,
    agentId: Uint256Schema,
    /** Execution address the agent acts from, when it publishes one. */
    agentWallet: AddressSchema.optional(),
    /** Hash of the ERC-8004 registration document as resolved at freeze time. */
    registrationUriHash: Bytes32Schema,
    agentVersionHash: Bytes32Schema,
    endpointHash: Bytes32Schema,
    skillHashes: z.array(Bytes32Schema),
  })
  .strict();
export type TrialAgent = z.infer<typeof TrialAgentSchema>;

export const TrialTaskSchema = z
  .object({
    protocolId: SlugSchema,
    /** Category-specific action, e.g. `restore-health-factor`, `rebalance-range`. */
    actionType: SlugSchema,
    /** Position id, pool id, market id — the thing being acted on, when there is one. */
    resourceId: z.string().min(1).optional(),
    /** Hash of the task input document handed to the agent. */
    inputHash: Bytes32Schema,
    /** Hash of the policy parameters, e.g. thresholds and targets. */
    parametersHash: Bytes32Schema,
  })
  .strict();

export const TrialScenarioSchema = z
  .object({
    scenarioId: SlugSchema,
    scenarioVersion: VersionSchema,
    scenarioHash: Bytes32Schema,
    /**
     * Commitment to a seed revealed only after the run.
     *
     * Withholding the seed stops an agent from recognising and special-casing a
     * scenario it has seen before; committing to it stops MANDATE from choosing
     * the seed after seeing the result.
     */
    seedCommitment: Bytes32Schema.optional(),
  })
  .strict();

export const TrialEvaluatorSchema = z
  .object({
    evaluatorId: SlugSchema,
    version: VersionSchema,
    /** Hash of the evaluator source. Published so a third party can read what judged the run. */
    codeHash: Bytes32Schema,
    /** Hash of the independent reference model the agent is measured against. */
    referenceModelHash: Bytes32Schema,
  })
  .strict();

export const TrialChainSchema = z
  .object({
    chainId: ChainIdSchema,
    /** The block the fork is pinned to. Pinning is what makes a rerun comparable. */
    snapshotBlock: BlockNumberSchema,
    /** State root or equivalent commitment at `snapshotBlock`, when the RPC exposes one. */
    rpcStateHash: Bytes32Schema.optional(),
  })
  .strict();

export const TrialTimingSchema = z
  .object({
    createdAt: UnixSecondsSchema,
    /** After this the spec may no longer start a run. */
    expiresAt: UnixSecondsSchema,
    /** How long a passing result stays current, in seconds. */
    evidenceMaxAge: z.number().int().positive(),
  })
  .strict();

export const TrialSpecSchema = z
  .object({
    schemaVersion: z.literal(TRIAL_SPEC_SCHEMA_VERSION),
    /** Random 32 bytes. Two otherwise identical specs stay distinct documents. */
    nonce: Bytes32Schema,
    chain: TrialChainSchema,
    agent: TrialAgentSchema,
    category: AgentCategorySchema,
    task: TrialTaskSchema,
    /**
     * The authority envelope the agent is tested inside.
     *
     * A pass certifies this envelope and nothing wider, so it is the ceiling on
     * every grant derived from the resulting receipt.
     */
    authority: AuthorityIRSchema,
    scenario: TrialScenarioSchema,
    evaluator: TrialEvaluatorSchema,
    timing: TrialTimingSchema,
  })
  .strict()
  .refine((spec) => spec.timing.expiresAt > spec.timing.createdAt, {
    message: "timing.expiresAt must be after timing.createdAt",
    path: ["timing", "expiresAt"],
  })
  .refine((spec) => spec.authority.chainId === spec.chain.chainId, {
    message: "authority.chainId must match chain.chainId",
    path: ["authority", "chainId"],
  });

export type TrialSpec = z.infer<typeof TrialSpecSchema>;

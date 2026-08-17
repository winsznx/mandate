/**
 * TrialReceipt — the public, append-only record of a trial outcome.
 *
 * The receipt asserts provenance, not truth: publisher P committed result R for
 * agent A under spec T using evidence E. Whether E supports R is left to
 * whoever reads it. That distinction is what keeps MANDATE from being a score
 * oracle that everyone has to trust.
 */
import { z } from "zod";
import {
  AddressSchema,
  BlockNumberSchema,
  Bytes32Schema,
  ChainIdSchema,
  Uint256Schema,
  UnixSecondsSchema,
} from "../primitives.js";

export const TRIAL_RECEIPT_SCHEMA_VERSION = "mandate.trial-receipt/1" as const;

/**
 * `ERROR` is not `FAIL`.
 *
 * A crashed fork or an unreachable RPC says nothing about the agent, so it
 * never reaches a receipt and never touches an agent's record.
 */
export const TrialOutcomeSchema = z.enum(["PASS", "FAIL"]);
export type TrialOutcome = z.infer<typeof TrialOutcomeSchema>;

export const TrialReceiptSchema = z
  .object({
    schemaVersion: z.literal(TRIAL_RECEIPT_SCHEMA_VERSION),
    /** Chain the receipt is published to, bound into `receiptId` so a receipt cannot be replayed across chains. */
    chainId: ChainIdSchema,

    identityRegistry: AddressSchema,
    agentId: Uint256Schema,
    agentVersionHash: Bytes32Schema,

    trialSpecHash: Bytes32Schema,
    /** Hash of the canonical AuthorityIR the agent was tested inside — the ceiling on any grant. */
    testedAuthorityHash: Bytes32Schema,

    scenarioHash: Bytes32Schema,
    evaluatorHash: Bytes32Schema,
    referenceModelHash: Bytes32Schema,

    result: TrialOutcomeSchema,

    evidenceHash: Bytes32Schema,
    /** Where the evidence bundle lives. The hash, not this string, is what is trusted. */
    evidenceURI: z.string().min(1).max(2048),

    snapshotBlock: BlockNumberSchema,
    createdAt: UnixSecondsSchema,
    /** After this the receipt is history, not current certification. */
    freshUntil: UnixSecondsSchema,

    publisher: AddressSchema,
  })
  .strict()
  .refine((receipt) => receipt.freshUntil > receipt.createdAt, {
    message: "freshUntil must be after createdAt",
    path: ["freshUntil"],
  });

export type TrialReceipt = z.infer<typeof TrialReceiptSchema>;

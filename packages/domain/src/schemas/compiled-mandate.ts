/**
 * CompiledMandate — the output of turning a tested envelope plus a user's
 * chosen limits into something an enforcement layer will actually apply.
 *
 * Compilation fails closed. If a constraint present in the granted authority
 * has no mechanical equivalent, the compiler emits `UNSUPPORTED_AUTHORITY`
 * rather than a session that enforces less than the interface promises. The
 * `proof` block records the comparator that established the subset relation, so
 * a verifier can recompute it rather than take the result on faith.
 */
import { z } from "zod";
import { Bytes32Schema, UnixSecondsSchema, VersionSchema } from "../primitives.js";
import {
  AuthorityIRSchema,
  DurableEffectsSchema,
  GuardConfigurationSchema,
} from "./authority-ir.js";

export const COMPILED_MANDATE_SCHEMA_VERSION = "mandate.compiled-mandate/1" as const;

export const COMPILER_WARNING_CODES = [
  /** A permitted call has no selector restriction, so every method on the target is reachable. */
  "WIDE_SELECTOR",
  /** An allowance created for this mandate outlives session revocation. */
  "RESIDUAL_APPROVAL",
  /** A semantic constraint is enforced by a guard rather than by the wallet layer. */
  "GUARD_ENFORCED_CONSTRAINT",
  /** The safety profile behind a call is older than the freshness policy allows. */
  "STALE_PROTOCOL_PROFILE",
  /** The target can be upgraded, so the profile can stop describing it at any time. */
  "UPGRADEABLE_TARGET",
  /** Granted spend is materially below tested spend, which limits what the agent can do. */
  "SPEND_HEADROOM_LOW",
  /** Granted lifetime is close to the tested bound. */
  "LIFETIME_NEAR_TESTED_BOUND",
] as const;

export const CompilerWarningSchema = z
  .object({
    code: z.enum(COMPILER_WARNING_CODES),
    message: z.string().min(1),
    /** Path into the AuthorityIR the warning concerns, e.g. `calls[0].selector`. */
    path: z.string().optional(),
  })
  .strict();
export type CompilerWarning = z.infer<typeof CompilerWarningSchema>;

export const COMPILER_ERROR_CODES = [
  /** Granted authority is not a subset of tested authority. */
  "NOT_A_SUBSET",
  /** A constraint cannot be expressed by the enforcement layer or by a guard. */
  "UNSUPPORTED_AUTHORITY",
  /** No safety profile exists for a call being granted. */
  "MISSING_PROTOCOL_PROFILE",
  /** A profile exists but the deployed code no longer matches it. */
  "PROFILE_INVALIDATED",
  /** The trial evidence is no longer current. */
  "EVIDENCE_NOT_CURRENT",
  /** The requested lifetime exceeds what the trial certified. */
  "LIFETIME_EXCEEDS_TESTED",
] as const;

export const CompilerErrorSchema = z
  .object({
    code: z.enum(COMPILER_ERROR_CODES),
    message: z.string().min(1),
    path: z.string().optional(),
  })
  .strict();
export type CompilerError = z.infer<typeof CompilerErrorSchema>;

/**
 * The session permissions in the enforcement layer's own vocabulary.
 *
 * Held opaque here on purpose: `packages/altana` owns the exact shape, and
 * pinning it into the domain package would couple the canonical document to one
 * vendor's SDK version. `permissionsHash` is what the receipt and the verifier
 * compare on.
 */
export const EnforcementBindingSchema = z
  .object({
    /** Identifier of the enforcement layer, e.g. `altana`. */
    layer: z.string().min(1),
    layerVersion: z.string().min(1),
    /** Canonical hash of the emitted permission document. */
    permissionsHash: Bytes32Schema,
    /** Absolute session deadline in the enforcement layer's terms. */
    expiry: UnixSecondsSchema,
  })
  .strict();

export const SubsetProofSchema = z
  .object({
    subset: z.boolean(),
    comparatorVersion: VersionSchema,
    /** Hash of the comparator source, so a verifier knows which rules produced the verdict. */
    comparatorHash: Bytes32Schema,
    /** Human-readable reasons the relation failed. Empty when `subset` is true. */
    violations: z.array(z.string().min(1)),
  })
  .strict();
export type SubsetProof = z.infer<typeof SubsetProofSchema>;

export const CompiledMandateSchema = z
  .object({
    schemaVersion: z.literal(COMPILED_MANDATE_SCHEMA_VERSION),

    /** Hash of the tested AuthorityIR, tying this grant to a specific receipt. */
    testedAuthorityHash: Bytes32Schema,
    grantedAuthorityHash: Bytes32Schema,
    /** The granted authority in full, so the hash above can be checked rather than trusted. */
    grantedAuthority: AuthorityIRSchema,

    enforcement: EnforcementBindingSchema,

    /** Side effects this mandate will create that outlive its session. */
    durableEffects: DurableEffectsSchema,

    guard: GuardConfigurationSchema.optional(),

    warnings: z.array(CompilerWarningSchema),
    proof: SubsetProofSchema,
  })
  .strict()
  .refine((compiled) => compiled.proof.subset, {
    message: "a compiled mandate must carry a passing subset proof",
    path: ["proof", "subset"],
  });

export type CompiledMandate = z.infer<typeof CompiledMandateSchema>;

/** Failure result. The compiler returns this instead of a mandate rather than degrading one. */
export interface CompilationFailure {
  ok: false;
  errors: CompilerError[];
  warnings: CompilerWarning[];
}

export interface CompilationSuccess {
  ok: true;
  mandate: CompiledMandate;
  warnings: CompilerWarning[];
}

export type CompilationResult = CompilationSuccess | CompilationFailure;

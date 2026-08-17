/**
 * AuthorityIR — MANDATE's intermediate representation of financial authority.
 *
 * It sits between two things that do not have the same vocabulary: what a trial
 * demonstrated, and what a wallet enforcement layer can mechanically restrict.
 * The IR is deliberately richer than any single enforcement layer, because a
 * protocol call can carry authority (an arbitrary recipient, an arbitrary asset)
 * that target-plus-selector restrictions cannot describe. Recording that
 * authority here is what lets the compiler refuse to emit a session whose real
 * reach is wider than the boundary shown to the user.
 *
 * Two closure rules govern every reader of this document:
 *  - `calls` is exhaustive. A call not listed is forbidden, never "unconstrained".
 *  - `spend` is exhaustive. A token not listed may not be spent at all.
 */
import { z } from "zod";
import {
  AddressSchema,
  Bytes32Schema,
  ChainIdSchema,
  HexSchema,
  SlugSchema,
  SpendPeriodSchema,
  Uint256Schema,
  UnixSecondsSchema,
  VersionSchema,
} from "../primitives.js";

export const AUTHORITY_IR_SCHEMA_VERSION = "mandate.authority-ir/1" as const;

/** ERC-8004 identity. An agent is `(registry, agentId)`, never a bare wallet address. */
export const AgentRefSchema = z.object({
  identityRegistry: AddressSchema,
  agentId: Uint256Schema,
});
export type AgentRef = z.infer<typeof AgentRefSchema>;

/** A 4-byte function selector. */
export const SelectorSchema = z
  .string()
  .regex(/^0x[0-9a-f]{8}$/, "must be lowercase 0x-prefixed 4-byte selector");

export const AmountConstraintSchema = z
  .object({
    /** Asset the bound applies to. `NATIVE` denotes the chain's gas token. */
    asset: z.union([AddressSchema, z.literal("NATIVE")]),
    maxPerCall: Uint256Schema,
    minPerCall: Uint256Schema.optional(),
  })
  .strict();
export type AmountConstraint = z.infer<typeof AmountConstraintSchema>;

/**
 * Constraints that live inside calldata rather than in the call target.
 *
 * An enforcement layer that only filters on target and selector cannot apply
 * these. When a call needs them, the compiler routes execution through a typed
 * guard instead of granting the protocol call directly.
 */
export const SemanticConstraintsSchema = z
  .object({
    /** Position ids, pool ids, market ids — whatever the protocol calls its resource handle. */
    resourceIds: z.array(z.string().min(1)).optional(),
    allowedRecipients: z.array(AddressSchema).optional(),
    allowedAssets: z.array(z.union([AddressSchema, z.literal("NATIVE")])).optional(),
    amountBounds: z.array(AmountConstraintSchema).optional(),
    slippageBpsMax: z.number().int().min(0).max(10_000).optional(),
    deadlineMaxSeconds: z.number().int().positive().optional(),
    /** Hash of an encoded path/route restriction, for protocols that take one. */
    pathConstraintsHash: Bytes32Schema.optional(),
  })
  .strict();
export type SemanticConstraints = z.infer<typeof SemanticConstraintsSchema>;

export const AuthorityCallSchema = z
  .object({
    target: AddressSchema,
    /** Absent means every selector on `target` is permitted — a wide grant the compiler warns about. */
    selector: SelectorSchema.optional(),
    /** Human-readable form of `selector`, e.g. `repayBorrow(uint256)`. Display only. */
    signature: z.string().min(1).optional(),
    protocolId: SlugSchema,
    /** Runtime code hash of the target at analysis time. A change invalidates the profile. */
    protocolVersionHash: Bytes32Schema.optional(),
    semanticConstraints: SemanticConstraintsSchema.optional(),
  })
  .strict();
export type AuthorityCall = z.infer<typeof AuthorityCallSchema>;

export const SpendLimitSchema = z
  .object({
    token: z.union([AddressSchema, z.literal("NATIVE")]),
    /** Base units of `token`. Decimals are a display concern, never a protocol one. */
    limit: Uint256Schema,
    period: SpendPeriodSchema,
  })
  .strict();
export type SpendLimit = z.infer<typeof SpendLimitSchema>;

/**
 * An ERC-20 allowance created to make a mandate work.
 *
 * Allowances outlive the session that needed them. Tracking them here is what
 * lets the product distinguish "session revoked" from "the agent can no longer
 * move your money", which are not the same statement.
 */
export const ApprovalEffectSchema = z
  .object({
    token: AddressSchema,
    spender: AddressSchema,
    maxAmount: Uint256Schema,
    createdBy: z.enum(["ADMIN", "SESSION", "GUARD"]),
    /** True only when the enforcement layer provably removes the allowance on revocation. */
    expiresWithSession: z.boolean(),
    /** True when revocation leaves the allowance in place and the user must clear it. */
    cleanupRequired: z.boolean(),
  })
  .strict();
export type ApprovalEffect = z.infer<typeof ApprovalEffectSchema>;

/** An ERC-1271 signature checker registered on the wallet — durable authority that is not a call permission. */
export const SignatureCheckerEffectSchema = z
  .object({
    checker: AddressSchema,
    scope: z.string().min(1),
    expiresWithSession: z.boolean(),
    cleanupRequired: z.boolean(),
  })
  .strict();

export const GenericDurableEffectSchema = z
  .object({
    kind: SlugSchema,
    description: z.string().min(1),
    target: AddressSchema.optional(),
    expiresWithSession: z.boolean(),
    cleanupRequired: z.boolean(),
  })
  .strict();

export const DurableEffectsSchema = z
  .object({
    approvals: z.array(ApprovalEffectSchema),
    signatureCheckers: z.array(SignatureCheckerEffectSchema),
    other: z.array(GenericDurableEffectSchema),
  })
  .strict();
export type DurableEffects = z.infer<typeof DurableEffectsSchema>;

/**
 * What the permitted call surface can reach beyond its own frame.
 *
 * Every flag is a capability, so `false` is always the tighter value. A granted
 * authority may turn a flag off relative to what was tested; it may never turn
 * one on.
 */
export const DownstreamPolicySchema = z
  .object({
    arbitraryExternalCalls: z.boolean(),
    delegateCallReachable: z.boolean(),
    multicallReachable: z.boolean(),
    arbitraryRecipientReachable: z.boolean(),
  })
  .strict();
export type DownstreamPolicy = z.infer<typeof DownstreamPolicySchema>;

export const GuardConfigurationSchema = z
  .object({
    guardAddress: AddressSchema,
    guardCodeHash: Bytes32Schema,
    guardVersion: VersionSchema,
  })
  .strict();
export type GuardConfiguration = z.infer<typeof GuardConfigurationSchema>;

/**
 * How long the authority may live.
 *
 * `maxDurationSeconds` is the comparable bound: a trial certifies a duration,
 * not a wall-clock instant, so the subset relation can be evaluated without a
 * clock. `notAfter` is the concrete deadline a compiled grant carries.
 */
export const AuthorityLifetimeSchema = z
  .object({
    maxDurationSeconds: z.number().int().positive().max(31_536_000),
    notAfter: UnixSecondsSchema.optional(),
  })
  .strict();
export type AuthorityLifetime = z.infer<typeof AuthorityLifetimeSchema>;

export const AuthorityIRSchema = z
  .object({
    schemaVersion: z.literal(AUTHORITY_IR_SCHEMA_VERSION),
    chainId: ChainIdSchema,
    subject: z
      .object({
        /** The wallet whose assets are at stake. Zero address on a tested authority, which is wallet-independent. */
        wallet: AddressSchema,
        agentIdentity: AgentRefSchema,
        agentVersionHash: Bytes32Schema,
      })
      .strict(),
    calls: z.array(AuthorityCallSchema).min(1),
    spend: z.array(SpendLimitSchema),
    durableEffects: DurableEffectsSchema,
    downstreamPolicy: DownstreamPolicySchema,
    guard: GuardConfigurationSchema.optional(),
    lifetime: AuthorityLifetimeSchema,
  })
  .strict();

export type AuthorityIR = z.infer<typeof AuthorityIRSchema>;

/** Stable sort key for a call. Sorting makes two semantically equal documents hash alike. */
export function authorityCallKey(call: AuthorityCall): string {
  return `${call.target}|${call.selector ?? ""}`;
}

/** Stable sort key for a spend limit. */
export function spendLimitKey(limit: SpendLimit): string {
  return `${limit.token}|${limit.period}`;
}

/** Placeholder subject wallet for a tested authority, which is not bound to any user. */
export const UNBOUND_WALLET = "0x0000000000000000000000000000000000000000" as const;

/** Empty durable-effect set, for building an authority that creates no lasting side effects. */
export function emptyDurableEffects(): DurableEffects {
  return { approvals: [], signatureCheckers: [], other: [] };
}

/** The tightest possible downstream policy — nothing beyond the call frame is reachable. */
export function closedDownstreamPolicy(): DownstreamPolicy {
  return {
    arbitraryExternalCalls: false,
    delegateCallReachable: false,
    multicallReachable: false,
    arbitraryRecipientReachable: false,
  };
}

export { HexSchema, AddressSchema, Bytes32Schema };

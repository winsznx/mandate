/**
 * ProtocolSafetyProfile — what a permitted call can actually do.
 *
 * Produced by the Effective Authority Analyzer from deployed bytecode and chain
 * state, before any session is designed around a call. The question it answers
 * is not "is this function named safely" but "given only permission to invoke
 * this selector on this target, what is reachable" — arbitrary recipients,
 * arbitrary assets, delegatecall, multicall, allowances that outlive the
 * session. A call whose answer cannot be bounded does not become a MANDATE
 * action, whatever its marketing value.
 */
import { z } from "zod";
import {
  AddressSchema,
  BlockNumberSchema,
  Bytes32Schema,
  ChainIdSchema,
  SlugSchema,
  UnixSecondsSchema,
  VersionSchema,
} from "../primitives.js";
import { SelectorSchema } from "./authority-ir.js";

export const PROTOCOL_SAFETY_PROFILE_SCHEMA_VERSION = "mandate.protocol-safety-profile/1" as const;

/**
 * The verdict that decides how a call is executed.
 *
 * `DIRECT_SAFE` means target, selector, spend cap and expiry describe the real
 * authority. `GUARD_REQUIRED` means calldata carries authority those four
 * dimensions cannot express, so execution is routed through a typed guard.
 * `UNSUPPORTED` means neither path bounds it, and the action is refused.
 */
export const SafetyVerdictSchema = z.enum(["DIRECT_SAFE", "GUARD_REQUIRED", "UNSUPPORTED"]);
export type SafetyVerdict = z.infer<typeof SafetyVerdictSchema>;

export const ProtocolSafetyProfileSchema = z
  .object({
    schemaVersion: z.literal(PROTOCOL_SAFETY_PROFILE_SCHEMA_VERSION),
    profileId: SlugSchema,
    chainId: ChainIdSchema,

    protocolId: SlugSchema,
    target: AddressSchema,
    selector: SelectorSchema,
    signature: z.string().min(1),

    /** Code hash of `target` itself. For a proxy this is the proxy, not the logic. */
    runtimeCodeHash: Bytes32Schema,
    implementation: AddressSchema.optional(),
    implementationCodeHash: Bytes32Schema.optional(),
    proxyType: z
      .enum(["NONE", "EIP1967", "TRANSPARENT", "UUPS", "BEACON", "DELEGATOR", "DIAMOND", "UNKNOWN"])
      .default("NONE"),
    upgradeable: z.boolean(),
    /** Who can change the implementation. Recorded because it is the practical bound on trusting the profile. */
    upgradeAdmin: AddressSchema.optional(),

    /** Can calldata direct value or output to an address the user did not choose. */
    arbitraryRecipient: z.boolean(),
    /** Can calldata select an asset outside the declared set. */
    arbitraryAsset: z.boolean(),
    /** Can the call reach a target chosen by calldata. */
    arbitraryDownstreamTarget: z.boolean(),
    delegateCallReachable: z.boolean(),
    multicallReachable: z.boolean(),
    /** Does using this call require an allowance that survives session revocation. */
    createsPersistentApproval: z.boolean(),
    /** Does the call hand control to a caller-chosen contract mid-execution. */
    callbackReachable: z.boolean(),

    verdict: SafetyVerdictSchema,

    /** Constraint names the analyzer proved this call respects. */
    supportedConstraints: z.array(SlugSchema),
    /** Anything the analyzer could not settle. A non-empty list forbids `DIRECT_SAFE`. */
    unresolvedRisks: z.array(z.string().min(1)),

    analyzedAtBlock: BlockNumberSchema,
    analyzedAt: UnixSecondsSchema,
    analyzerVersion: VersionSchema,
  })
  .strict()
  .refine(
    (profile) => profile.verdict !== "DIRECT_SAFE" || profile.unresolvedRisks.length === 0,
    {
      message: "DIRECT_SAFE requires an empty unresolvedRisks list",
      path: ["verdict"],
    },
  )
  .refine(
    (profile) =>
      profile.verdict !== "DIRECT_SAFE" ||
      !(
        profile.arbitraryRecipient ||
        profile.arbitraryAsset ||
        profile.arbitraryDownstreamTarget ||
        profile.delegateCallReachable ||
        profile.multicallReachable
      ),
    {
      message:
        "DIRECT_SAFE is incompatible with an arbitrary recipient, asset, downstream target, delegatecall or multicall",
      path: ["verdict"],
    },
  )
  .refine(
    (profile) => profile.proxyType === "NONE" || profile.implementation !== undefined,
    { message: "a proxy profile must record its implementation address", path: ["implementation"] },
  );

export type ProtocolSafetyProfile = z.infer<typeof ProtocolSafetyProfileSchema>;

/** A profile is stale once the code it was derived from no longer matches what is deployed. */
export function isProfileStale(
  profile: ProtocolSafetyProfile,
  observed: { runtimeCodeHash: string; implementationCodeHash?: string | undefined },
): boolean {
  if (observed.runtimeCodeHash !== profile.runtimeCodeHash) return true;
  if (profile.implementationCodeHash === undefined) return false;
  return observed.implementationCodeHash !== profile.implementationCodeHash;
}

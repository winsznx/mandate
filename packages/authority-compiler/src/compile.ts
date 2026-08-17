/**
 * The Authority Compiler.
 *
 * Turns a tested envelope plus the limits a user actually chose into session
 * permissions an enforcement layer will apply. Every rule here is a refusal
 * condition, because the compiler's job is not to produce a session — it is to
 * refuse to produce one whenever the session would enforce less than the
 * interface promises.
 *
 * It fails closed in four situations, and the last two are the ones that make
 * the product honest rather than merely careful:
 *
 *  1. The granted authority is not within the tested authority.
 *  2. A permitted call has no current ProtocolSafetyProfile.
 *  3. A call's profile says `GUARD_REQUIRED` and no guard is configured. The
 *     alternative would be emitting a session whose displayed scope is narrower
 *     than its real reach, which is the exact failure MANDATE exists to prevent.
 *  4. A constraint in the AuthorityIR has no mechanical equivalent. Dropping it
 *     silently would leave the user reading a boundary nothing enforces.
 */
import {
  isSubset,
  COMPARATOR_VERSION,
  COMPARATOR_RULES_HASH,
  authorityHash,
} from "@mandate/authority-ir";
import {
  COMPILED_MANDATE_SCHEMA_VERSION,
  SPEND_PERIOD_SECONDS,
  type ApprovalEffect,
  type AuthorityIR,
  type CompilationResult,
  type CompilerError,
  type CompilerWarning,
  type ProtocolSafetyProfile,
} from "@mandate/domain";
import {
  requestedPermissionsHash,
  serializePermissions,
  type RequestedCallPermission,
  type RequestedSessionPermissions,
  type RequestedSpendPermission,
} from "@mandate/altana";
import type { Address } from "viem";

export const COMPILER_VERSION = "1.0.0" as const;

export interface CompileInput {
  /** The envelope a passing trial certified. The ceiling on everything below. */
  tested: AuthorityIR;
  /** What the user asked to grant. Must be within `tested`. */
  granted: AuthorityIR;
  /** One profile per permitted call, keyed `${target}|${selector}`. */
  profiles: ReadonlyMap<string, ProtocolSafetyProfile>;
  /** Trial evidence must still be current at grant time. */
  evidenceIsCurrent: boolean;
  /** Absolute session deadline, unix seconds. */
  expiry: number;
  /** Evaluation time, unix seconds. Injected so compilation is deterministic in tests. */
  now: number;
  /** Session public key, for the requested-permissions commitment. */
  sessionPublicKey: `0x${string}`;
}

export function profileKey(target: string, selector: string | undefined): string {
  return `${target.toLowerCase()}|${(selector ?? "").toLowerCase()}`;
}

/**
 * Size the standing ERC-20 allowance a mandate needs.
 *
 * A protocol that pulls funds with `transferFrom` needs an allowance the session
 * cannot create for itself, because permitting `approve` would widen the
 * session's real authority from "reduce my own debt" to "move this token to any
 * address". So the allowance is created once by the admin, and it must cover the
 * mandate's whole lifetime rather than a single period.
 *
 * Sizing it to one period looks tighter and is a trap. With a 25-per-day cap and
 * a 25 allowance, a 20 repayment leaves 5, and the next 6 fails on the ERC-20
 * allowance rather than on the spend cap. The mandate would appear bounded while
 * the binding constraint was a misconfiguration, and the proof would be of the
 * wrong thing entirely.
 *
 * The residual allowance is still a second, monotonically decreasing ceiling the
 * session cannot top up, so this is not a widening.
 */
export function standingAllowanceFor(params: {
  periodLimit: bigint;
  period: keyof typeof SPEND_PERIOD_SECONDS;
  lifetimeSeconds: number;
}): bigint {
  const periodSeconds = SPEND_PERIOD_SECONDS[params.period];
  // Round up: a lifetime that straddles a boundary genuinely spans both buckets.
  const periods = BigInt(Math.max(1, Math.ceil(params.lifetimeSeconds / periodSeconds)));
  return params.periodLimit * periods;
}

/** Emit the call permissions for one AuthorityIR call. */
function toCallPermission(call: AuthorityIR["calls"][number], guardAddress?: Address): RequestedCallPermission {
  // With a guard, the session is permitted to call the GUARD, never the protocol
  // directly. Emitting the protocol target as well would defeat the guard.
  const target = guardAddress ?? call.target;
  if (call.selector === undefined) return { to: target };
  return { to: target, signature: call.selector };
}

/**
 * Compile a granted authority into session permissions.
 *
 * Returns a failure rather than a degraded mandate. There is no partial success
 * mode: a session that enforces some of the constraints is not a weaker version
 * of the right answer, it is a boundary the user would be misled by.
 */
export function compileAuthority(input: CompileInput): CompilationResult {
  const errors: CompilerError[] = [];
  const warnings: CompilerWarning[] = [];

  if (!input.evidenceIsCurrent) {
    errors.push({
      code: "EVIDENCE_NOT_CURRENT",
      message: "The trial evidence backing this authority is no longer current",
    });
  }

  const subset = isSubset(input.granted, input.tested);
  if (!subset.subset) {
    for (const violation of subset.violations) {
      errors.push({
        code: "NOT_A_SUBSET",
        message: violation.message,
        path: violation.path,
      });
    }
  }

  const lifetimeSeconds = input.expiry - input.now;
  if (lifetimeSeconds <= 0) {
    errors.push({
      code: "LIFETIME_EXCEEDS_TESTED",
      message: "The requested expiry is not in the future",
      path: "expiry",
    });
  } else if (lifetimeSeconds > input.granted.lifetime.maxDurationSeconds) {
    errors.push({
      code: "LIFETIME_EXCEEDS_TESTED",
      message: `The requested session would live ${lifetimeSeconds}s, beyond the granted bound of ${input.granted.lifetime.maxDurationSeconds}s`,
      path: "expiry",
    });
  }

  const guardAddress = input.granted.guard?.guardAddress;
  const calls: RequestedCallPermission[] = [];

  for (const [index, call] of input.granted.calls.entries()) {
    const path = `calls[${index}]`;
    const profile = input.profiles.get(profileKey(call.target, call.selector));

    if (profile === undefined) {
      errors.push({
        code: "MISSING_PROTOCOL_PROFILE",
        message: `No safety profile exists for ${call.selector ?? "any selector"} on ${call.target}, so its real reach is unknown`,
        path,
      });
      continue;
    }

    if (call.protocolVersionHash !== undefined) {
      const deployed = profile.implementationCodeHash ?? profile.runtimeCodeHash;
      if (deployed !== call.protocolVersionHash) {
        errors.push({
          code: "PROFILE_INVALIDATED",
          message: `The code deployed at ${call.target} no longer matches the version this authority was built against`,
          path,
        });
        continue;
      }
    }

    if (profile.verdict === "UNSUPPORTED") {
      errors.push({
        code: "UNSUPPORTED_AUTHORITY",
        message: `${call.target} cannot be bounded by any supported mechanism`,
        path,
      });
      continue;
    }

    if (profile.verdict === "GUARD_REQUIRED" && guardAddress === undefined) {
      errors.push({
        code: "UNSUPPORTED_AUTHORITY",
        message: `${call.selector ?? "this call"} on ${call.target} carries authority in its calldata that target-and-selector restrictions cannot bound, and no guard is configured`,
        path,
      });
      continue;
    }

    // Semantic constraints live in calldata. The enforcement layer has no
    // calldata predicates, so a guard is the only thing that can apply them.
    if (call.semanticConstraints !== undefined && guardAddress === undefined) {
      errors.push({
        code: "UNSUPPORTED_AUTHORITY",
        message: `${path} declares semantic constraints that no configured mechanism can enforce`,
        path: `${path}.semanticConstraints`,
      });
      continue;
    }

    if (call.semanticConstraints !== undefined) {
      warnings.push({
        code: "GUARD_ENFORCED_CONSTRAINT",
        message: `Constraints on ${path} are enforced by the guard at ${guardAddress}, not by the wallet layer`,
        path,
      });
    }

    if (call.selector === undefined) {
      warnings.push({
        code: "WIDE_SELECTOR",
        message: `Every method on ${call.target} is permitted`,
        path,
      });
    }

    if (profile.upgradeable) {
      warnings.push({
        code: "UPGRADEABLE_TARGET",
        message: `${call.target} can be upgraded by ${profile.upgradeAdmin ?? "an unknown admin"}, so this profile can stop describing it at any time`,
        path,
      });
    }

    calls.push(toCallPermission(call, guardAddress));
  }

  const spend: RequestedSpendPermission[] = input.granted.spend.map((limit) => {
    const permission: RequestedSpendPermission = {
      limit: BigInt(limit.limit),
      period: limit.period,
    };
    if (limit.token !== "NATIVE") permission.token = limit.token;
    return permission;
  });

  // An empty call list would mean "all targets permitted" to the enforcement
  // layer, which inverts the intent completely.
  if (calls.length === 0 && errors.length === 0) {
    errors.push({
      code: "UNSUPPORTED_AUTHORITY",
      message:
        "Compilation produced no call permissions. An empty permission set means unrestricted targets, so it is refused.",
      path: "calls",
    });
  }

  const approvals: ApprovalEffect[] = input.granted.durableEffects.approvals.map((approval) => ({
    ...approval,
  }));

  if (errors.length > 0) return { ok: false, errors, warnings };

  for (const approval of approvals) {
    if (approval.cleanupRequired) {
      warnings.push({
        code: "RESIDUAL_APPROVAL",
        message: `An allowance of ${approval.maxAmount} for ${approval.spender} on ${approval.token} survives revocation and must be cleared separately`,
      });
    }
  }

  const permissions: RequestedSessionPermissions = { calls, spend };
  const serialized = serializePermissions(permissions);

  return {
    ok: true,
    warnings,
    mandate: {
      schemaVersion: COMPILED_MANDATE_SCHEMA_VERSION,
      testedAuthorityHash: authorityHash(input.tested),
      grantedAuthorityHash: authorityHash(input.granted),
      grantedAuthority: input.granted,
      enforcement: {
        layer: "altana",
        layerVersion: "0.7.1",
        permissionsHash: requestedPermissionsHash({
          chainId: input.granted.chainId,
          walletAddress: input.granted.subject.wallet,
          publicKey: input.sessionPublicKey,
          requestedPermissions: serialized,
          expiry: input.expiry,
        }),
        expiry: input.expiry,
      },
      durableEffects: {
        approvals,
        signatureCheckers: input.granted.durableEffects.signatureCheckers,
        other: input.granted.durableEffects.other,
      },
      ...(input.granted.guard === undefined ? {} : { guard: input.granted.guard }),
      warnings,
      proof: {
        subset: true,
        comparatorVersion: COMPARATOR_VERSION,
        comparatorHash: COMPARATOR_RULES_HASH,
        violations: [],
      },
    },
    // The emitted permissions travel beside the mandate rather than inside it,
    // because they contain bigints and the mandate document must stay canonical.
  } satisfies CompilationResult;
}

/**
 * The session permissions a successful compilation implies.
 *
 * Kept separate from `CompiledMandate` because that document is canonical JSON
 * and these carry `bigint`. Recomputed rather than stored so the two can never
 * drift.
 */
export function permissionsFor(granted: AuthorityIR): RequestedSessionPermissions {
  const guardAddress = granted.guard?.guardAddress;
  return {
    calls: granted.calls.map((call) => toCallPermission(call, guardAddress)),
    spend: granted.spend.map((limit) => {
      const permission: RequestedSpendPermission = {
        limit: BigInt(limit.limit),
        period: limit.period,
      };
      if (limit.token !== "NATIVE") permission.token = limit.token;
      return permission;
    }),
  };
}

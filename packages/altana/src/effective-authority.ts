/**
 * Requested authority is not effective authority.
 *
 * The gap between the two is the thing MANDATE exists to catch, and Altana
 * supplies a live example of it. Porto rewrites a session's permissions on the
 * way to the chain: every session key silently receives a wildcard-selector
 * call permission for the Orchestrator, and the relay's fee handling can enlarge
 * a spend permission. Neither appears in the object the application passed to
 * `grantSession`.
 *
 * An interface that renders `session.permissions` is therefore showing the user
 * a request, labelled as a boundary. This module reads what the account actually
 * enforces, reconstructs it as an AuthorityIR, and reports every difference so
 * the discrepancy is disclosed rather than reproduced.
 *
 * MANDATE displays the reconstruction. The request is only ever shown beside it,
 * as the thing that was asked for.
 */
import { toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";
import {
  AUTHORITY_IR_SCHEMA_VERSION,
  closedDownstreamPolicy,
  emptyDurableEffects,
  type AgentRef,
  type AuthorityCall,
  type AuthorityIR,
  type SpendLimit,
  type SpendPeriod,
} from "@mandate/domain";
import { ANY_FN_SEL, ANY_TARGET } from "./constants.js";
import type { EnforcedAuthority, EnforcedCallRule } from "./account-reads.js";

/** The SDK's permission shape, restated so this package does not re-export SDK types into the domain. */
export type RequestedCallPermission =
  | { to: Address; signature: string }
  | { signature: string }
  | { to: Address };

export interface RequestedSpendPermission {
  limit: bigint;
  period: SpendPeriod;
  /** Omitted for the native token. */
  token?: Address;
}

export interface RequestedSessionPermissions {
  calls?: readonly RequestedCallPermission[];
  spend?: readonly RequestedSpendPermission[];
}

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/**
 * Normalise a requested call permission into the `(target, selector)` pair the
 * account will actually store.
 *
 * Mirrors Porto's conversion: an omitted field becomes the corresponding
 * wildcard, and `signature` may be either a human-readable ABI signature or a
 * raw 4-byte selector.
 */
export function normalizeRequestedCall(permission: RequestedCallPermission): {
  target: Address;
  selector: Hex;
} {
  const target = "to" in permission ? (permission.to.toLowerCase() as Address) : ANY_TARGET;

  if (!("signature" in permission)) return { target, selector: ANY_FN_SEL };

  const { signature } = permission;
  const selector = /^0x[0-9a-fA-F]{8}$/.test(signature)
    ? (signature.toLowerCase() as Hex)
    : toFunctionSelector(signature);

  return { target, selector };
}

export const DISCREPANCY_CODES = [
  /** The account enforces a call rule the application never requested. */
  "UNREQUESTED_CALL_RULE",
  /** A requested rule is absent from the account, so the session is narrower than believed. */
  "MISSING_REQUESTED_CALL_RULE",
  /** A rule permits every contract. Effectively unbounded. */
  "WILDCARD_TARGET",
  /** A rule permits every method on a contract. */
  "WILDCARD_SELECTOR",
  /** A wallet-wide rule widens this session without appearing in its own permission set. */
  "WALLET_WIDE_RULE",
  /** The account enforces a spend permission the application never requested. */
  "UNREQUESTED_SPEND_LIMIT",
  /** The enforced cap is higher than the one requested. */
  "SPEND_LIMIT_ENLARGED",
  /** The enforced cap is lower than the one requested. */
  "SPEND_LIMIT_REDUCED",
  /** A requested spend permission is absent, so the token cannot be moved at all. */
  "MISSING_REQUESTED_SPEND_LIMIT",
  /** The key bypasses the guard entirely. Nothing below is enforced. */
  "SUPER_ADMIN_KEY",
  /** No key with this hash exists on the account. */
  "KEY_NOT_REGISTERED",
  /** The account's expiry differs from what was requested. */
  "EXPIRY_MISMATCH",
] as const;

export type DiscrepancyCode = (typeof DISCREPANCY_CODES)[number];

/**
 * How much a discrepancy matters.
 *
 * `CRITICAL` means the displayed boundary is not the real one and no mandate
 * may be activated. `DISCLOSE` means the difference is real, benign and must
 * still be shown — the Orchestrator permission is the canonical example.
 */
export type DiscrepancySeverity = "CRITICAL" | "DISCLOSE" | "INFO";

export interface AuthorityDiscrepancy {
  code: DiscrepancyCode;
  severity: DiscrepancySeverity;
  message: string;
  target?: Address;
  selector?: Hex;
  token?: Address;
}

const CRITICAL_CODES: readonly DiscrepancyCode[] = [
  "WILDCARD_TARGET",
  "SUPER_ADMIN_KEY",
  "KEY_NOT_REGISTERED",
  "SPEND_LIMIT_ENLARGED",
  "WALLET_WIDE_RULE",
];

function ruleKey(target: Address, selector: Hex): string {
  return `${target.toLowerCase()}|${selector.toLowerCase()}`;
}

/**
 * Is this enforced rule the Orchestrator permission Porto adds to every session?
 *
 * Recognised specifically so it can be reported as an expected, benign addition
 * rather than as an unexplained extra target. Calling it out by name is the
 * difference between disclosure and noise: a user who sees "one unrequested
 * permission" with no explanation learns nothing useful.
 */
export function isOrchestratorRule(rule: EnforcedCallRule, orchestrator: Address): boolean {
  return rule.target === orchestrator.toLowerCase() && rule.selectorIsWildcard;
}

export interface DiscrepancyContext {
  orchestrator: Address;
  requestedExpiry?: number;
}

/**
 * Compare what was asked for against what the chain enforces.
 *
 * Reports every difference in both directions. A missing rule matters as much
 * as an extra one: a session narrower than the interface claims will fail
 * mid-mandate, and the user deserves to know before they rely on it.
 */
export function diffRequestedVsEnforced(
  requested: RequestedSessionPermissions,
  enforced: EnforcedAuthority,
  context: DiscrepancyContext,
): AuthorityDiscrepancy[] {
  const discrepancies: AuthorityDiscrepancy[] = [];
  const add = (
    code: DiscrepancyCode,
    message: string,
    extra: Omit<AuthorityDiscrepancy, "code" | "severity" | "message"> = {},
  ): void => {
    discrepancies.push({
      code,
      severity: CRITICAL_CODES.includes(code) ? "CRITICAL" : "DISCLOSE",
      message,
      ...extra,
    });
  };

  if (!enforced.registered) {
    add("KEY_NOT_REGISTERED", "The account holds no key with this hash, so nothing is enforced");
    return discrepancies;
  }

  // A super-admin key skips the guard entirely: no call check, no spend check.
  // Everything else in this report would be describing rules that never run.
  if (enforced.isSuperAdmin) {
    add(
      "SUPER_ADMIN_KEY",
      "This key is a super admin. Call and spend restrictions are not applied to it at all",
    );
    return discrepancies;
  }

  const requestedRules = new Map<string, { target: Address; selector: Hex }>();
  for (const permission of requested.calls ?? []) {
    const normalized = normalizeRequestedCall(permission);
    requestedRules.set(ruleKey(normalized.target, normalized.selector), normalized);
  }

  const enforcedKeys = new Set(enforced.callRules.map((rule) => ruleKey(rule.target, rule.selector)));

  for (const rule of enforced.callRules) {
    if (rule.targetIsWildcard) {
      add("WILDCARD_TARGET", "A rule permits every contract on the chain", {
        target: rule.target,
        selector: rule.selector,
      });
      continue;
    }

    const known = requestedRules.has(ruleKey(rule.target, rule.selector));

    if (!known) {
      if (isOrchestratorRule(rule, context.orchestrator)) {
        add(
          "UNREQUESTED_CALL_RULE",
          `The wallet layer added a wildcard-selector permission for the Orchestrator at ${rule.target}. Every session key receives this; it is required for the session to submit anything at all, and it was not requested by MANDATE`,
          { target: rule.target, selector: rule.selector },
        );
      } else {
        add(
          "UNREQUESTED_CALL_RULE",
          `The account enforces a rule for ${rule.target} that was never requested`,
          { target: rule.target, selector: rule.selector },
        );
      }
      continue;
    }

    if (rule.selectorIsWildcard) {
      add("WILDCARD_SELECTOR", `Every method on ${rule.target} is permitted`, {
        target: rule.target,
        selector: rule.selector,
      });
    }
  }

  for (const [key, rule] of requestedRules) {
    if (!enforcedKeys.has(key)) {
      add(
        "MISSING_REQUESTED_CALL_RULE",
        `${rule.selector} on ${rule.target} was requested but the account does not enforce it, so the session cannot make this call`,
        { target: rule.target, selector: rule.selector },
      );
    }
  }

  for (const rule of enforced.walletWideRules) {
    add(
      "WALLET_WIDE_RULE",
      `A wallet-wide rule permits ${rule.selector} on ${rule.target} for every key on this account, including this session`,
      { target: rule.target, selector: rule.selector },
    );
  }

  const requestedSpend = new Map<string, RequestedSpendPermission>();
  for (const permission of requested.spend ?? []) {
    const token = (permission.token ?? NATIVE_TOKEN).toLowerCase() as Address;
    requestedSpend.set(`${token}|${permission.period}`, permission);
  }

  for (const limit of enforced.spendLimits) {
    const key = `${limit.token}|${limit.period}`;
    const match = requestedSpend.get(key);

    if (match === undefined) {
      add(
        "UNREQUESTED_SPEND_LIMIT",
        `The account enforces a ${limit.period} cap of ${limit.limit} on ${limit.token} that was never requested`,
        { token: limit.token },
      );
      continue;
    }

    if (limit.limit > match.limit) {
      add(
        "SPEND_LIMIT_ENLARGED",
        `The enforced ${limit.period} cap on ${limit.token} is ${limit.limit}, above the requested ${match.limit}`,
        { token: limit.token },
      );
    } else if (limit.limit < match.limit) {
      add(
        "SPEND_LIMIT_REDUCED",
        `The enforced ${limit.period} cap on ${limit.token} is ${limit.limit}, below the requested ${match.limit}`,
        { token: limit.token },
      );
    }
  }

  for (const [key, permission] of requestedSpend) {
    const token = key.split("|")[0] as Address;
    if (!enforced.spendLimits.some((limit) => `${limit.token}|${limit.period}` === key)) {
      add(
        "MISSING_REQUESTED_SPEND_LIMIT",
        `A ${permission.period} cap on ${token} was requested but is not enforced, so the session cannot move this token at all`,
        { token },
      );
    }
  }

  if (context.requestedExpiry !== undefined && context.requestedExpiry !== enforced.expiry) {
    add(
      "EXPIRY_MISMATCH",
      `The account expires this key at ${enforced.expiry}, not the requested ${context.requestedExpiry}`,
    );
  }

  return discrepancies;
}

/** True when at least one discrepancy makes the displayed boundary untrustworthy. */
export function hasCriticalDiscrepancy(discrepancies: readonly AuthorityDiscrepancy[]): boolean {
  return discrepancies.some((discrepancy) => discrepancy.severity === "CRITICAL");
}

export interface ReconstructionContext {
  chainId: number;
  wallet: Address;
  agentIdentity: AgentRef;
  agentVersionHash: Hex;
  orchestrator: Address;
  /** Maps a target address to the protocol it belongs to, for display. */
  protocolIdFor: (target: Address) => string;
  /** Set when the session executes through a typed guard. */
  guard?: AuthorityIR["guard"];
}

/**
 * Rebuild an AuthorityIR from what the account enforces.
 *
 * This is the document the proof page renders and the verifier hashes. It is
 * derived entirely from chain reads, so reproducing it needs no access to
 * MANDATE's database.
 *
 * The Orchestrator rule is included rather than filtered out. Hiding it would
 * make the reconstruction agree with the request by concealing exactly the kind
 * of difference this function exists to surface, and it is a real permission the
 * session really holds.
 */
export function reconstructAuthorityIR(
  enforced: EnforcedAuthority,
  context: ReconstructionContext,
  now: number,
): AuthorityIR {
  const calls: AuthorityCall[] = [...enforced.callRules, ...enforced.walletWideRules].map((rule) => {
    const call: AuthorityCall = {
      target: rule.target,
      protocolId: rule.targetIsWildcard
        ? "any-target"
        : rule.target === context.orchestrator.toLowerCase()
          ? "altana-orchestrator"
          : context.protocolIdFor(rule.target),
    };
    // A wildcard selector is the ABSENCE of a selector restriction, which the
    // AuthorityIR expresses by omitting the field. Recording 0x32323232 as a
    // literal selector would read as a narrow grant.
    if (!rule.selectorIsWildcard) call.selector = rule.selector;
    return call;
  });

  const spend: SpendLimit[] = enforced.spendLimits
    .filter((limit) => limit.period !== "forever")
    .map((limit) => ({
      token: limit.token === NATIVE_TOKEN ? ("NATIVE" as const) : limit.token,
      limit: limit.limit.toString(10),
      period: limit.period as SpendPeriod,
    }));

  const remainingSeconds = Math.max(0, enforced.expiry - now);

  const authority: AuthorityIR = {
    schemaVersion: AUTHORITY_IR_SCHEMA_VERSION,
    chainId: context.chainId,
    subject: {
      wallet: context.wallet.toLowerCase() as Address,
      agentIdentity: context.agentIdentity,
      agentVersionHash: context.agentVersionHash,
    },
    calls,
    spend,
    durableEffects: emptyDurableEffects(),
    // The account forbids a session from calling itself and force-zeroes any
    // approval it makes, so a session cannot escalate or reach an arbitrary
    // downstream target through the guard. Whether the PERMITTED protocol call
    // does is a separate question, answered by its ProtocolSafetyProfile.
    downstreamPolicy: closedDownstreamPolicy(),
    lifetime: {
      maxDurationSeconds: Math.max(1, remainingSeconds),
      notAfter: enforced.expiry,
    },
  };

  if (context.guard !== undefined) authority.guard = context.guard;

  return authority;
}

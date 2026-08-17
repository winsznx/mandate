/**
 * The subset comparator.
 *
 * MANDATE's whole claim reduces to one relation:
 *
 *     GrantedEnforceableAuthority ⊆ TestedEnforceableAuthority
 *
 * Everything else — the marketplace, the trials, the receipts — exists to make
 * that relation meaningful. This file decides it, and it decides fail-closed:
 * anything the rules do not explicitly permit is a violation, and a dimension
 * the comparator does not understand is a violation rather than an omission.
 *
 * Two conventions are worth stating outright, because they are easy to get
 * backwards:
 *
 *  - An ABSENT constraint is the BROAD reading. No `selector` means every
 *    selector; no `allowedRecipients` means any recipient. So granted-absent
 *    against tested-present is a widening and fails.
 *  - An ABSENT list ENTRY is the NARROW reading. `calls` and `spend` are
 *    exhaustive, so a call or token the granted authority omits is simply not
 *    permitted, which is always allowed.
 */
import {
  SPEND_PERIOD_SECONDS,
  type AmountConstraint,
  type ApprovalEffect,
  type AuthorityCall,
  type AuthorityIR,
  type SemanticConstraints,
  type SpendLimit,
} from "@mandate/domain";
import { canonicalHash } from "@mandate/domain/canonical";
import { canonicalizeAuthority } from "./canonicalize.js";
import type { Hex } from "viem";

export const COMPARATOR_VERSION = "1.0.0" as const;

/**
 * The rule set this comparator applies, in a form a verifier can hash.
 *
 * `comparatorHash` commits to these rule identifiers, not to the source bytes.
 * A published proof therefore states which rules produced the verdict; reading
 * the implementation is still how you check that the rules were applied.
 */
export const COMPARATOR_RULES = [
  "chain-id-equal",
  "agent-identity-equal",
  "agent-version-equal",
  "every-granted-call-covered",
  "granted-selector-no-wider-than-tested",
  "granted-semantic-constraints-no-wider",
  "every-granted-spend-covered",
  "granted-spend-limit-not-greater",
  "granted-spend-period-not-shorter",
  "granted-approvals-covered",
  "granted-signature-checkers-covered",
  "granted-other-durable-effects-covered",
  "granted-downstream-flags-not-enabled",
  "guard-identical",
  "granted-lifetime-not-longer",
] as const;

export const COMPARATOR_RULES_HASH: Hex = canonicalHash({
  comparator: "mandate.authority-subset",
  version: COMPARATOR_VERSION,
  rules: [...COMPARATOR_RULES],
});

export interface SubsetViolation {
  rule: (typeof COMPARATOR_RULES)[number];
  path: string;
  message: string;
}

export interface SubsetResult {
  subset: boolean;
  violations: SubsetViolation[];
  comparatorVersion: typeof COMPARATOR_VERSION;
  comparatorHash: Hex;
}

type Violations = SubsetViolation[];

function violate(
  violations: Violations,
  rule: (typeof COMPARATOR_RULES)[number],
  path: string,
  message: string,
): void {
  violations.push({ rule, path, message });
}

/** A tested call covers a granted one when the target matches and the granted selector is no wider. */
function callCovers(tested: AuthorityCall, granted: AuthorityCall): boolean {
  if (tested.target !== granted.target) return false;
  // Tested with no selector permits every selector, so it covers any granted
  // selector on the same target. Tested with a selector covers only that one,
  // and a granted call with no selector is strictly wider.
  if (tested.selector === undefined) return true;
  return tested.selector === granted.selector;
}

function isStringSubset(granted: readonly string[], tested: readonly string[]): boolean {
  const allowed = new Set(tested);
  return granted.every((value) => allowed.has(value));
}

function amountBoundsCover(
  tested: readonly AmountConstraint[],
  granted: readonly AmountConstraint[] | undefined,
): string | undefined {
  if (granted === undefined) {
    return "tested bounds per-call amounts but granted does not";
  }
  const grantedByAsset = new Map(granted.map((bound) => [bound.asset, bound]));
  for (const testedBound of tested) {
    const grantedBound = grantedByAsset.get(testedBound.asset);
    if (grantedBound === undefined) {
      return `no granted per-call bound for asset ${testedBound.asset}`;
    }
    if (BigInt(grantedBound.maxPerCall) > BigInt(testedBound.maxPerCall)) {
      return `granted maxPerCall ${grantedBound.maxPerCall} exceeds tested ${testedBound.maxPerCall} for ${testedBound.asset}`;
    }
  }
  // A granted bound on an asset tested left unbounded only tightens things.
  return undefined;
}

/**
 * Compare semantic constraints on a matched call.
 *
 * Each dimension is checked independently, and every failure is reported rather
 * than short-circuiting, so a user who requested too much sees the full list of
 * what a new trial would have to cover.
 */
function checkSemanticConstraints(
  tested: SemanticConstraints | undefined,
  granted: SemanticConstraints | undefined,
  path: string,
  violations: Violations,
): void {
  if (tested === undefined) return; // Tested constrained nothing here; anything granted is narrower.

  const rule = "granted-semantic-constraints-no-wider" as const;
  const g = granted ?? {};

  const listChecks: Array<["resourceIds" | "allowedRecipients" | "allowedAssets", string]> = [
    ["resourceIds", "resource ids"],
    ["allowedRecipients", "recipients"],
    ["allowedAssets", "assets"],
  ];

  for (const [field, label] of listChecks) {
    const testedList: readonly string[] | undefined = tested[field];
    if (testedList === undefined) continue;
    const grantedList: readonly string[] | undefined = g[field];
    if (grantedList === undefined) {
      violate(violations, rule, `${path}.${field}`, `tested restricts ${label} but granted does not`);
      continue;
    }
    if (!isStringSubset(grantedList, testedList)) {
      violate(
        violations,
        rule,
        `${path}.${field}`,
        `granted ${label} include values outside the tested set`,
      );
    }
  }

  if (tested.amountBounds !== undefined) {
    const problem = amountBoundsCover(tested.amountBounds, g.amountBounds);
    if (problem !== undefined) violate(violations, rule, `${path}.amountBounds`, problem);
  }

  const numericChecks: Array<["slippageBpsMax" | "deadlineMaxSeconds", string]> = [
    ["slippageBpsMax", "maximum slippage"],
    ["deadlineMaxSeconds", "maximum deadline"],
  ];

  for (const [field, label] of numericChecks) {
    const testedValue = tested[field];
    if (testedValue === undefined) continue;
    const grantedValue = g[field];
    if (grantedValue === undefined) {
      violate(violations, rule, `${path}.${field}`, `tested bounds ${label} but granted does not`);
      continue;
    }
    if (grantedValue > testedValue) {
      violate(
        violations,
        rule,
        `${path}.${field}`,
        `granted ${label} ${grantedValue} exceeds tested ${testedValue}`,
      );
    }
  }

  if (tested.pathConstraintsHash !== undefined && g.pathConstraintsHash !== tested.pathConstraintsHash) {
    violate(
      violations,
      rule,
      `${path}.pathConstraintsHash`,
      "granted path constraints differ from the tested ones",
    );
  }
}

/**
 * Does a tested spend allowance cover a granted one?
 *
 * Rate comparison alone is unsound: `100/week` has a lower rate than `25/day`
 * yet permits spending 100 in a single hour, which `25/day` never allows. The
 * sound rule is that the granted burst must not be larger and the granted window
 * must not be shorter — then any window the tested limit governs contains at
 * most the granted limit, which is at most the tested one.
 */
function spendCovers(tested: SpendLimit, granted: SpendLimit): boolean {
  if (tested.token !== granted.token) return false;
  if (BigInt(granted.limit) > BigInt(tested.limit)) return false;
  return SPEND_PERIOD_SECONDS[granted.period] >= SPEND_PERIOD_SECONDS[tested.period];
}

function approvalCovers(tested: ApprovalEffect, granted: ApprovalEffect): boolean {
  return (
    tested.token === granted.token &&
    tested.spender === granted.spender &&
    BigInt(granted.maxAmount) <= BigInt(tested.maxAmount)
  );
}

/**
 * Decide whether `granted` is within `tested`.
 *
 * Both inputs are canonicalised first so that ordering differences cannot
 * change the verdict.
 */
export function isSubset(granted: AuthorityIR, tested: AuthorityIR): SubsetResult {
  const g = canonicalizeAuthority(granted);
  const t = canonicalizeAuthority(tested);
  const violations: Violations = [];

  if (g.chainId !== t.chainId) {
    violate(violations, "chain-id-equal", "chainId", `granted chain ${g.chainId} is not tested chain ${t.chainId}`);
  }

  if (
    g.subject.agentIdentity.identityRegistry !== t.subject.agentIdentity.identityRegistry ||
    g.subject.agentIdentity.agentId !== t.subject.agentIdentity.agentId
  ) {
    violate(
      violations,
      "agent-identity-equal",
      "subject.agentIdentity",
      "granted authority names a different agent than the trial certified",
    );
  }

  // A rebuilt agent did not earn the evidence, whatever its identity says.
  if (g.subject.agentVersionHash !== t.subject.agentVersionHash) {
    violate(
      violations,
      "agent-version-equal",
      "subject.agentVersionHash",
      "granted authority names a different agent version than the trial certified",
    );
  }

  g.calls.forEach((grantedCall, index) => {
    const path = `calls[${index}]`;
    const covering = t.calls.filter((testedCall) => callCovers(testedCall, grantedCall));

    if (covering.length === 0) {
      const sameTarget = t.calls.some((testedCall) => testedCall.target === grantedCall.target);
      if (!sameTarget) {
        violate(
          violations,
          "every-granted-call-covered",
          path,
          `target ${grantedCall.target} was not tested`,
        );
      } else {
        violate(
          violations,
          "granted-selector-no-wider-than-tested",
          path,
          grantedCall.selector === undefined
            ? `granted permits every selector on ${grantedCall.target} while the trial tested specific ones`
            : `selector ${grantedCall.selector} on ${grantedCall.target} was not tested`,
        );
      }
      return;
    }

    // When several tested calls cover this one, the granted call is acceptable
    // if any of them accepts its semantic constraints. Report the narrowest
    // failure set so the message stays actionable.
    let best: Violations | undefined;
    for (const testedCall of covering) {
      const attempt: Violations = [];
      checkSemanticConstraints(testedCall.semanticConstraints, grantedCall.semanticConstraints, path, attempt);
      if (attempt.length === 0) return;
      if (best === undefined || attempt.length < best.length) best = attempt;
    }
    if (best !== undefined) violations.push(...best);
  });

  g.spend.forEach((grantedSpend, index) => {
    const path = `spend[${index}]`;
    if (t.spend.some((testedSpend) => spendCovers(testedSpend, grantedSpend))) return;

    const sameToken = t.spend.filter((testedSpend) => testedSpend.token === grantedSpend.token);
    if (sameToken.length === 0) {
      violate(
        violations,
        "every-granted-spend-covered",
        path,
        `spending ${grantedSpend.token} was not tested`,
      );
      return;
    }
    for (const testedSpend of sameToken) {
      if (BigInt(grantedSpend.limit) > BigInt(testedSpend.limit)) {
        violate(
          violations,
          "granted-spend-limit-not-greater",
          path,
          `granted limit ${grantedSpend.limit} of ${grantedSpend.token} exceeds tested ${testedSpend.limit} per ${testedSpend.period}`,
        );
      } else {
        violate(
          violations,
          "granted-spend-period-not-shorter",
          path,
          `granted period ${grantedSpend.period} for ${grantedSpend.token} is shorter than tested ${testedSpend.period}, which raises the rate`,
        );
      }
    }
  });

  g.durableEffects.approvals.forEach((approval, index) => {
    if (t.durableEffects.approvals.some((testedApproval) => approvalCovers(testedApproval, approval))) {
      return;
    }
    violate(
      violations,
      "granted-approvals-covered",
      `durableEffects.approvals[${index}]`,
      `allowance of ${approval.maxAmount} for ${approval.spender} on ${approval.token} was not tested`,
    );
  });

  g.durableEffects.signatureCheckers.forEach((checker, index) => {
    if (
      t.durableEffects.signatureCheckers.some(
        (testedChecker) => testedChecker.checker === checker.checker && testedChecker.scope === checker.scope,
      )
    ) {
      return;
    }
    violate(
      violations,
      "granted-signature-checkers-covered",
      `durableEffects.signatureCheckers[${index}]`,
      `signature checker ${checker.checker} was not tested`,
    );
  });

  g.durableEffects.other.forEach((effect, index) => {
    if (
      t.durableEffects.other.some(
        (testedEffect) => testedEffect.kind === effect.kind && testedEffect.target === effect.target,
      )
    ) {
      return;
    }
    violate(
      violations,
      "granted-other-durable-effects-covered",
      `durableEffects.other[${index}]`,
      `durable effect ${effect.kind} was not tested`,
    );
  });

  const downstreamFlags = [
    "arbitraryExternalCalls",
    "delegateCallReachable",
    "multicallReachable",
    "arbitraryRecipientReachable",
  ] as const;

  for (const flag of downstreamFlags) {
    if (g.downstreamPolicy[flag] && !t.downstreamPolicy[flag]) {
      violate(
        violations,
        "granted-downstream-flags-not-enabled",
        `downstreamPolicy.${flag}`,
        `granted authority enables ${flag}, which the trial did not test`,
      );
    }
  }

  // A different guard is a different enforcement path, so it needs its own trial.
  const guardsMatch =
    (g.guard === undefined && t.guard === undefined) ||
    (g.guard !== undefined &&
      t.guard !== undefined &&
      g.guard.guardAddress === t.guard.guardAddress &&
      g.guard.guardCodeHash === t.guard.guardCodeHash &&
      g.guard.guardVersion === t.guard.guardVersion);

  if (!guardsMatch) {
    violate(
      violations,
      "guard-identical",
      "guard",
      g.guard === undefined
        ? "the trial ran behind a guard the granted authority omits"
        : t.guard === undefined
          ? "granted authority introduces a guard the trial did not test"
          : "granted guard differs from the tested guard",
    );
  }

  if (g.lifetime.maxDurationSeconds > t.lifetime.maxDurationSeconds) {
    violate(
      violations,
      "granted-lifetime-not-longer",
      "lifetime.maxDurationSeconds",
      `granted lifetime ${g.lifetime.maxDurationSeconds}s exceeds tested ${t.lifetime.maxDurationSeconds}s`,
    );
  }

  return {
    subset: violations.length === 0,
    violations,
    comparatorVersion: COMPARATOR_VERSION,
    comparatorHash: COMPARATOR_RULES_HASH,
  };
}

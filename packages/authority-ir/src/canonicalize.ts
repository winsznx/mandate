/**
 * Canonicalisation of an AuthorityIR.
 *
 * Two authorities that permit exactly the same things must hash to the same
 * value, or the subset proof a verifier recomputes would not match the one a
 * receipt committed to. Ordering inside `calls`, `spend` and the durable-effect
 * lists carries no meaning, so it is normalised away here rather than left to
 * whichever code path happened to build the document.
 */
import { canonicalHash, type CanonicalValue } from "@mandate/domain/canonical";
import {
  authorityCallKey,
  spendLimitKey,
  type ApprovalEffect,
  type AuthorityCall,
  type AuthorityIR,
  type SemanticConstraints,
  type SpendLimit,
} from "@mandate/domain";
import type { Hex } from "viem";

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

/**
 * Order a semantic-constraint block.
 *
 * Membership lists are sets, so they are sorted and de-duplicated. An empty
 * list is not the same as an absent one — it forbids everything, where absent
 * means the dimension is unconstrained — so empty lists are preserved.
 */
function canonicalizeSemanticConstraints(constraints: SemanticConstraints): SemanticConstraints {
  const result: SemanticConstraints = {};

  if (constraints.resourceIds !== undefined) {
    result.resourceIds = sortStrings([...new Set(constraints.resourceIds)]);
  }
  if (constraints.allowedRecipients !== undefined) {
    result.allowedRecipients = sortStrings([...new Set(constraints.allowedRecipients)]) as typeof constraints.allowedRecipients;
  }
  if (constraints.allowedAssets !== undefined) {
    result.allowedAssets = sortStrings([...new Set(constraints.allowedAssets)]) as typeof constraints.allowedAssets;
  }
  if (constraints.amountBounds !== undefined) {
    result.amountBounds = [...constraints.amountBounds].sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));
  }
  if (constraints.slippageBpsMax !== undefined) result.slippageBpsMax = constraints.slippageBpsMax;
  if (constraints.deadlineMaxSeconds !== undefined) {
    result.deadlineMaxSeconds = constraints.deadlineMaxSeconds;
  }
  if (constraints.pathConstraintsHash !== undefined) {
    result.pathConstraintsHash = constraints.pathConstraintsHash;
  }

  return result;
}

function canonicalizeCall(call: AuthorityCall): AuthorityCall {
  const result: AuthorityCall = {
    target: call.target,
    protocolId: call.protocolId,
  };
  if (call.selector !== undefined) result.selector = call.selector;
  if (call.signature !== undefined) result.signature = call.signature;
  if (call.protocolVersionHash !== undefined) result.protocolVersionHash = call.protocolVersionHash;
  if (call.semanticConstraints !== undefined) {
    result.semanticConstraints = canonicalizeSemanticConstraints(call.semanticConstraints);
  }
  return result;
}

function compareByKey<T>(key: (value: T) => string) {
  return (a: T, b: T): number => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

function approvalKey(approval: ApprovalEffect): string {
  return `${approval.token}|${approval.spender}|${approval.createdBy}`;
}

/**
 * Produce the canonical form of an authority.
 *
 * `subject.wallet` is preserved. It does not participate in the subset relation
 * — a tested envelope belongs to an agent version rather than to a user — but it
 * is part of what a granted authority commits to, so it stays in the hash.
 */
export function canonicalizeAuthority(authority: AuthorityIR): AuthorityIR {
  const canonical: AuthorityIR = {
    schemaVersion: authority.schemaVersion,
    chainId: authority.chainId,
    subject: {
      wallet: authority.subject.wallet,
      agentIdentity: {
        identityRegistry: authority.subject.agentIdentity.identityRegistry,
        agentId: authority.subject.agentIdentity.agentId,
      },
      agentVersionHash: authority.subject.agentVersionHash,
    },
    calls: authority.calls.map(canonicalizeCall).sort(compareByKey(authorityCallKey)),
    spend: [...authority.spend].sort(compareByKey<SpendLimit>(spendLimitKey)),
    durableEffects: {
      approvals: [...authority.durableEffects.approvals].sort(compareByKey(approvalKey)),
      signatureCheckers: [...authority.durableEffects.signatureCheckers].sort(
        compareByKey((effect) => `${effect.checker}|${effect.scope}`),
      ),
      other: [...authority.durableEffects.other].sort(
        compareByKey((effect) => `${effect.kind}|${effect.target ?? ""}`),
      ),
    },
    downstreamPolicy: {
      arbitraryExternalCalls: authority.downstreamPolicy.arbitraryExternalCalls,
      delegateCallReachable: authority.downstreamPolicy.delegateCallReachable,
      multicallReachable: authority.downstreamPolicy.multicallReachable,
      arbitraryRecipientReachable: authority.downstreamPolicy.arbitraryRecipientReachable,
    },
    lifetime: { maxDurationSeconds: authority.lifetime.maxDurationSeconds },
  };

  if (authority.lifetime.notAfter !== undefined) {
    canonical.lifetime.notAfter = authority.lifetime.notAfter;
  }
  if (authority.guard !== undefined) canonical.guard = authority.guard;

  return canonical;
}

/**
 * Hash of the canonical authority.
 *
 * This is the value written to a receipt as `testedAuthorityHash` and to a
 * mandate as `grantedAuthorityHash`.
 */
export function authorityHash(authority: AuthorityIR): Hex {
  return canonicalHash(canonicalizeAuthority(authority) as unknown as CanonicalValue);
}

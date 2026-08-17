/**
 * Evidence provenance and freshness.
 *
 * MANDATE never reduces evidence to a single score, because the number would
 * hide the only thing that matters: how the claim was established. A developer's
 * assertion and a reproducible trial can describe the same behaviour and are not
 * interchangeable, so provenance travels with every metric and is displayed
 * rather than averaged away.
 */

/** Public labels. These strings are user-visible and are not renamed casually. */
export const EVIDENCE_PROVENANCE = [
  /** Supplied by the developer. Displayed as a claim; never grants authority. */
  "Claimed",
  /** A public BSC event exists, but its link to this agent is unproven. */
  "Public Activity",
  /** The acting address is cryptographically tied to the agent identity. */
  "Identity-bound",
  /** This agent version passed a reproducible MANDATE trial. */
  "Trial-verified",
  /** The action ran through a known MANDATE session, so attribution is direct. */
  "Mandate-native",
  /** A mandate-native execution was additionally re-checked against the reference model. */
  "Mandate-verified",
] as const;

export type EvidenceProvenance = (typeof EVIDENCE_PROVENANCE)[number];

/**
 * Ordering by strength of attribution.
 *
 * Used to pick the label for an aggregate, which always takes the weakest
 * provenance among its inputs. Presenting a mixed set at its strongest would be
 * the exact overstatement this taxonomy exists to prevent.
 */
const PROVENANCE_RANK: Record<EvidenceProvenance, number> = {
  Claimed: 0,
  "Public Activity": 1,
  "Identity-bound": 2,
  "Trial-verified": 3,
  "Mandate-native": 4,
  "Mandate-verified": 5,
};

export function provenanceRank(provenance: EvidenceProvenance): number {
  return PROVENANCE_RANK[provenance];
}

export function isAtLeast(provenance: EvidenceProvenance, floor: EvidenceProvenance): boolean {
  return PROVENANCE_RANK[provenance] >= PROVENANCE_RANK[floor];
}

/** The provenance of a set of evidence is the weakest member's. */
export function weakestProvenance(values: readonly EvidenceProvenance[]): EvidenceProvenance | undefined {
  let weakest: EvidenceProvenance | undefined;
  for (const value of values) {
    if (weakest === undefined || PROVENANCE_RANK[value] < PROVENANCE_RANK[weakest]) weakest = value;
  }
  return weakest;
}

/** Provenance levels strong enough to justify granting live authority. */
export const AUTHORITY_BEARING_PROVENANCE: readonly EvidenceProvenance[] = [
  "Trial-verified",
  "Mandate-native",
  "Mandate-verified",
];

export function canJustifyAuthority(provenance: EvidenceProvenance): boolean {
  return AUTHORITY_BEARING_PROVENANCE.includes(provenance);
}

export const EVIDENCE_STATUSES = [
  "CURRENT",
  "STALE",
  "SUPERSEDED",
  "INVALIDATED",
  "UNVERIFIED",
] as const;

export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export interface FreshnessInput {
  observedAt: number;
  maxAgeSeconds: number;
  now: number;
  /** The agent version the evidence was produced against. */
  evidenceAgentVersionHash: string;
  currentAgentVersionHash: string;
  /** Set when a newer evidence artifact covers the same claim. */
  supersededBy?: string | undefined;
  /** Set when a security event or protocol change invalidated the assumptions. */
  invalidatedReason?: string | undefined;
  /** False when the protocol safety profile the evidence relied on no longer matches deployed code. */
  protocolProfileCurrent?: boolean | undefined;
}

/**
 * Resolve the status of an evidence artifact.
 *
 * Checked strongest-signal-first: an invalidated artifact is invalidated no
 * matter how recent, and an agent-version change supersedes evidence regardless
 * of its age. Stale evidence stays visible as history; it just stops counting as
 * current certification.
 */
export function evaluateFreshness(input: FreshnessInput): EvidenceStatus {
  if (input.invalidatedReason) return "INVALIDATED";
  if (input.protocolProfileCurrent === false) return "INVALIDATED";
  if (input.evidenceAgentVersionHash !== input.currentAgentVersionHash) return "SUPERSEDED";
  if (input.supersededBy) return "SUPERSEDED";
  if (input.now - input.observedAt > input.maxAgeSeconds) return "STALE";
  return "CURRENT";
}

/** Only current evidence may back a new grant. */
export function isCurrent(status: EvidenceStatus): boolean {
  return status === "CURRENT";
}

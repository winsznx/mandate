/**
 * Marketplace qualification.
 *
 * A registration is not an agent. BSC carries hundreds of thousands of ERC-8004
 * registrations, and a uniform sample of 300 found roughly three quarters to be
 * bulk-mint entries from a single publisher, 3.2% declaring any service at all,
 * and none declaring a skill. Presenting that inventory as a marketplace would
 * be the central dishonesty this product exists to avoid — the same dishonesty
 * as showing a developer's claim next to a reproducible trial result and letting
 * the reader assume they are equivalent.
 *
 * So identity and capability are separated. Every registration may be findable
 * through search, because a thing that exists on chain should be discoverable.
 * Only agents that answer, that fit the task, and that carry evidence enter the
 * primary marketplace ranking.
 *
 * This is the supply-side twin of `provenance.ts`: that one grades how a claim
 * about an agent was established, this one grades how far an agent has proven
 * it can be hired at all.
 */

import { provenanceRank, type EvidenceProvenance } from "./provenance.js";

export const QUALIFICATION_STAGES = [
  /** An ERC-8004 identity exists. Says nothing about whether anything is behind it. */
  "REGISTERED",
  /** The registration resolves to a well-formed document declaring at least one service. */
  "ENDPOINT_VERIFIED",
  /** The endpoint answered a real protocol handshake. Something is actually running. */
  "CALLABLE",
  /** It declares and accepts a task shape for one of the four categories. */
  "CATEGORY_COMPATIBLE",
  /** A specific version passed a reproducible MANDATE trial. */
  "TRIAL_VERIFIED",
  /** It has executed under a live mandate, so its record is directly attributable. */
  "MANDATE_NATIVE",
] as const;

export type QualificationStage = (typeof QUALIFICATION_STAGES)[number];

const STAGE_RANK: Record<QualificationStage, number> = {
  REGISTERED: 0,
  ENDPOINT_VERIFIED: 1,
  CALLABLE: 2,
  CATEGORY_COMPATIBLE: 3,
  TRIAL_VERIFIED: 4,
  MANDATE_NATIVE: 5,
};

export function stageRank(stage: QualificationStage): number {
  return STAGE_RANK[stage];
}

/**
 * The floor for the primary marketplace.
 *
 * Below this an agent may appear in search results, clearly labelled, but it
 * never competes for placement beside one that has completed a trial. A user
 * comparing two cards is entitled to assume both can be hired.
 */
export const MARKETPLACE_FLOOR: QualificationStage = "CATEGORY_COMPATIBLE";

export function entersMarketplaceRanking(stage: QualificationStage): boolean {
  return STAGE_RANK[stage] >= STAGE_RANK[MARKETPLACE_FLOOR];
}

/** Discoverable through search, with its stage shown. Everything on chain qualifies. */
export function isDiscoverable(stage: QualificationStage): boolean {
  return STAGE_RANK[stage] >= STAGE_RANK.REGISTERED;
}

/**
 * Why an agent did not reach the next stage.
 *
 * Recorded per agent so a developer sees a specific, fixable reason instead of
 * an unexplained absence, and so the marketplace can show why a registration is
 * not offered for hire.
 */
export const DISQUALIFICATION_REASONS = [
  "URI_UNRESOLVABLE",
  "URI_NOT_JSON",
  "REGISTRATION_MALFORMED",
  "NO_SERVICES_DECLARED",
  "ENDPOINT_UNREACHABLE",
  "ENDPOINT_TIMEOUT",
  "ENDPOINT_REJECTED_HANDSHAKE",
  "ENDPOINT_REQUIRES_AUTH",
  "NO_CATEGORY_DECLARED",
  "CATEGORY_TASK_UNSUPPORTED",
  "BULK_MINT_PUBLISHER",
  "NO_CURRENT_TRIAL",
  "TRIAL_FAILED",
] as const;

export type DisqualificationReason = (typeof DISQUALIFICATION_REASONS)[number];

export interface QualificationAssessment {
  stage: QualificationStage;
  /** Empty once the agent reaches MANDATE_NATIVE. */
  blockedBy: DisqualificationReason[];
  /** When the assessment was made. Callability decays and must be rechecked. */
  assessedAt: number;
}

export interface QualificationSignals {
  registrationResolves: boolean;
  registrationWellFormed: boolean;
  declaresService: boolean;
  endpointAnswered: boolean;
  endpointRequiresAuth: boolean;
  declaresCategory: boolean;
  acceptsCategoryTask: boolean;
  hasCurrentPassingTrial: boolean;
  hasMandateNativeExecution: boolean;
  /**
   * True when the publisher is a known bulk minter.
   *
   * A heuristic and treated as one: it caps an agent at REGISTERED rather than
   * hiding it, so a real agent from a prolific publisher can still climb by
   * answering and passing a trial. The signal is about presentation order, not
   * about truth.
   */
  publisherIsBulkMinter: boolean;
}

/**
 * Assess how far an agent has qualified.
 *
 * Stages are strictly ordered and evaluated in order, stopping at the first
 * unmet requirement, because a later signal cannot compensate for an earlier
 * one. An agent with a passing trial whose endpoint no longer answers is not
 * hireable, and ranking it on the strength of the old trial would send a user
 * to an agent that cannot be reached.
 */
export function assessQualification(
  signals: QualificationSignals,
  assessedAt: number,
): QualificationAssessment {
  const blockedBy: DisqualificationReason[] = [];
  const at = (stage: QualificationStage): QualificationAssessment => ({ stage, blockedBy, assessedAt });

  if (!signals.registrationResolves) {
    blockedBy.push("URI_UNRESOLVABLE");
    return at("REGISTERED");
  }
  if (!signals.registrationWellFormed) {
    blockedBy.push("REGISTRATION_MALFORMED");
    return at("REGISTERED");
  }
  if (!signals.declaresService) {
    blockedBy.push("NO_SERVICES_DECLARED");
    return at("REGISTERED");
  }
  if (signals.publisherIsBulkMinter && !signals.endpointAnswered) {
    blockedBy.push("BULK_MINT_PUBLISHER");
    return at("REGISTERED");
  }

  if (!signals.endpointAnswered) {
    blockedBy.push(signals.endpointRequiresAuth ? "ENDPOINT_REQUIRES_AUTH" : "ENDPOINT_UNREACHABLE");
    return at("ENDPOINT_VERIFIED");
  }

  if (!signals.declaresCategory) {
    blockedBy.push("NO_CATEGORY_DECLARED");
    return at("CALLABLE");
  }
  if (!signals.acceptsCategoryTask) {
    blockedBy.push("CATEGORY_TASK_UNSUPPORTED");
    return at("CALLABLE");
  }

  if (!signals.hasCurrentPassingTrial) {
    blockedBy.push("NO_CURRENT_TRIAL");
    return at("CATEGORY_COMPATIBLE");
  }

  if (!signals.hasMandateNativeExecution) return at("TRIAL_VERIFIED");

  return at("MANDATE_NATIVE");
}

/**
 * Sort key for marketplace listing.
 *
 * Qualification dominates every other signal. A bulk-mint registration can
 * never sort above a reference agent that completed a trial, whatever its
 * claimed metrics say, because the claim and the trial are not the same kind of
 * statement and ordering them together would imply they were.
 */
export function qualificationSortKey(assessment: QualificationAssessment): number {
  return STAGE_RANK[assessment.stage];
}

/* -------------------------------------------------------------------------- */
/*  The tie between qualification and provenance                              */
/* -------------------------------------------------------------------------- */

/**
 * The strongest provenance a given qualification stage can support.
 *
 * `provenance.ts` grades how a claim was established; this module grades how far
 * an agent has proven it can be hired. Kept apart they are two descriptive
 * scales, and nothing stops an interface labelling a scaffold that merely
 * answers a handshake as `Trial-verified`.
 *
 * That is not a hypothetical. MANDATE ships four categories at deliberately
 * different depths, and the honest presentation of that is the provenance
 * ladder. A ladder anyone can climb by assertion is decoration, so the ceiling
 * is enforced here and the display reads it rather than choosing for itself.
 *
 * The mapping is conservative: reaching a stage does not grant the provenance,
 * it merely stops forbidding it. An agent at `TRIAL_VERIFIED` may still be shown
 * as `Claimed` if that is all its evidence supports.
 */
const PROVENANCE_CEILING: Record<QualificationStage, EvidenceProvenance> = {
  // Nothing is behind a bare registration, so a developer's word is all there is.
  REGISTERED: "Claimed",
  ENDPOINT_VERIFIED: "Claimed",
  // Something answers, but answering is not evidence of financial behaviour.
  CALLABLE: "Public Activity",
  CATEGORY_COMPATIBLE: "Identity-bound",
  TRIAL_VERIFIED: "Trial-verified",
  MANDATE_NATIVE: "Mandate-verified",
};

/** The strongest provenance this stage permits. */
export function provenanceCeilingFor(stage: QualificationStage): EvidenceProvenance {
  return PROVENANCE_CEILING[stage];
}

/** True when `provenance` is within what `stage` can support. */
export function provenanceIsSupported(
  provenance: EvidenceProvenance,
  stage: QualificationStage,
): boolean {
  return provenanceRank(provenance) <= provenanceRank(PROVENANCE_CEILING[stage]);
}

/**
 * Clamp a provenance label to what the agent's qualification actually supports.
 *
 * Display code calls this rather than trusting a stored label, so an agent that
 * regressed — its endpoint went dark, its version changed — cannot keep
 * advertising evidence it can no longer back.
 */
export function displayProvenance(
  claimed: EvidenceProvenance,
  stage: QualificationStage,
): { provenance: EvidenceProvenance; clamped: boolean } {
  const ceiling = PROVENANCE_CEILING[stage];
  if (provenanceRank(claimed) <= provenanceRank(ceiling)) {
    return { provenance: claimed, clamped: false };
  }
  return { provenance: ceiling, clamped: true };
}

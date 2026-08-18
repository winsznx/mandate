/**
 * What may and may not be said, read from the binding ledger itself.
 *
 * `claims/ledger.json` is the statement of record: a claim absent from it may
 * not appear in the README, the demo or this page, and its NOT_CLAIMED entries
 * exist to record what is deliberately not asserted. Importing the file rather
 * than restating it means the page cannot drift from the ledger — an entry
 * demoted there is demoted here on the next build.
 *
 * The page renders the limitations as prominently as the claims. A proof
 * surface that showed only what held would be advertising.
 */
import ledger from "../../../../claims/ledger.json" with { type: "json" };

export type ClaimStatus = "VERIFIED" | "PARTIAL" | "NOT_CLAIMED" | "NOT_CLAIMED_AS_TRANSACTION";

export interface LedgerClaim {
  claimId: string;
  wording: string;
  status: string;
  proofLevel: number;
  limitations: string[];
}

export interface ProofLadderRung {
  rung: number;
  description: string;
}

const claims: LedgerClaim[] = ledger.claims.map((claim) => ({
  claimId: claim.claimId,
  wording: claim.wording,
  status: claim.status,
  proofLevel: claim.proofLevel,
  limitations: [...claim.limitations],
}));

export const LEDGER_GENERATED_AT: string = ledger.generatedAt;

/** Claims with evidence behind them, highest rung first. */
export function establishedClaims(): LedgerClaim[] {
  return claims
    .filter((claim) => claim.status === "VERIFIED" || claim.status === "PARTIAL")
    .sort((a, b) => b.proofLevel - a.proofLevel);
}

/**
 * Claims MANDATE deliberately does not make.
 *
 * Includes `rejection-produces-no-transaction`, which is not a weakness being
 * confessed but the shape of the guarantee: the refusal is earlier and stronger
 * than a revert, and it is a different artifact that must be described as one.
 */
export function withheldClaims(): LedgerClaim[] {
  return claims.filter(
    (claim) => claim.status === "NOT_CLAIMED" || claim.status === "NOT_CLAIMED_AS_TRANSACTION",
  );
}

export function claimById(claimId: string): LedgerClaim | undefined {
  return claims.find((claim) => claim.claimId === claimId);
}

export function proofLadder(): ProofLadderRung[] {
  return Object.entries(ledger.proofLadder)
    .map(([rung, description]) => ({ rung: Number(rung), description }))
    .sort((a, b) => a.rung - b.rung);
}

export function rungDescription(level: number): string {
  const rung = proofLadder().find((entry) => entry.rung === level);
  return rung?.description ?? "no rung recorded";
}

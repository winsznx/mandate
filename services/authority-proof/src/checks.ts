/**
 * The Phase 2 gate, expressed as checks rather than prose.
 *
 * Each entry is a claim that either holds against a live chain or does not.
 * They are defined separately from the script that runs them so the same list
 * drives the runner, the proof page and the claim ledger, and so a claim cannot
 * quietly appear in the README without a check behind it.
 *
 * Note what is deliberately absent: there is no check named "the session is
 * safe". Every claim here names a specific mechanism and a specific observable.
 */

export const PHASE_2_CHECKS = [
  {
    id: "authority-roundtrip",
    claim: "A compiled AuthorityIR round-trips through a granted session and back to the same document",
    method:
      "Compile the granted AuthorityIR to session permissions, grant it, read canExecutePackedInfos and spendInfos, reconstruct an AuthorityIR from those reads, and compare hashes.",
  },
  {
    id: "disclosed-matches-enforced",
    claim: "The policy shown to the user matches what the account enforces, including additions the wallet layer made",
    method:
      "Diff the requested permissions against the enforced ones. Every difference must be reported. The Orchestrator permission the wallet layer appends must be present and disclosed, never filtered out.",
  },
  {
    id: "spend-at-limit-succeeds",
    claim: "A call at exactly the granted spend limit succeeds",
    method: "Repay an amount equal to the remaining allowance in the current UTC bucket.",
  },
  {
    id: "spend-above-limit-blocked",
    claim: "A call that would exceed the cumulative bucket total is rejected by the account, not by MANDATE",
    method:
      "Repay again so the bucket total would exceed the cap. The transaction must revert with ExceededSpendLimit (0x9054c912) raised inside the user's own account contract. An ERC-20 allowance revert does NOT satisfy this check.",
  },
  {
    id: "wrong-target-blocked",
    claim: "A call to a contract outside the granted scope is rejected",
    method: "Invoke the same selector on a different vToken. Must revert UnauthorizedCall.",
  },
  {
    id: "wrong-selector-blocked",
    claim: "A different method on the granted contract is rejected",
    method: "Invoke borrow(uint256) on the granted vToken. Must revert UnauthorizedCall.",
  },
  {
    id: "expiry-blocks-execution",
    claim: "A session past its expiry cannot execute",
    method: "Grant a short-lived session, wait past its expiry, and attempt a permitted call.",
  },
  {
    id: "revocation-blocks-execution",
    claim: "A revoked session cannot execute, and revocation is account-level",
    method:
      "Revoke, confirm the account no longer holds the key, then attempt a previously permitted call.",
  },
  {
    id: "keystore-view-distinguished",
    claim: "MANDATE distinguishes account authority from an external KeyStore view of it",
    method:
      "After revocation, report the account's own state and the public KeyStore's state separately. A stale external view must never be presented as live authority.",
  },
  {
    id: "admin-approval-surfaced",
    claim: "The standing admin approval is disclosed as a durable effect and can be cleaned up",
    method:
      "Show the allowance in the mandate record, then clear it with an admin-path approve(spender, 0) and confirm the allowance reads zero.",
  },
  {
    id: "erc1271-outside-mandate",
    claim:
      "ERC-1271 signing paths bypass both call and spend enforcement, and are excluded from the first proof",
    method:
      "Assert that no mandate session is ever passed to signOrder, fetchWithX402 or approveSignatureChecker, and record the carve-out explicitly rather than implying the session cannot sign.",
  },
] as const;

export type Phase2CheckId = (typeof PHASE_2_CHECKS)[number]["id"];

export type CheckStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export interface CheckResult {
  id: Phase2CheckId;
  status: CheckStatus;
  /** What was actually observed. Empty on NOT_RUN. */
  observed: string;
  /** Transaction hashes, addresses and revert selectors backing the result. */
  evidence: string[];
}

/**
 * Phase 2 passes only when every check passes.
 *
 * `BLOCKED` is reported separately from `FAIL` because they call for different
 * responses: a blocked check means the environment was missing something, and
 * reporting it as a failure would be as misleading as reporting it as a pass.
 * Neither counts toward the gate.
 */
export function gatePasses(results: readonly CheckResult[]): boolean {
  if (results.length !== PHASE_2_CHECKS.length) return false;
  return results.every((result) => result.status === "PASS");
}

export function summarize(results: readonly CheckResult[]): string {
  const width = Math.max(...PHASE_2_CHECKS.map((check) => check.id.length));
  const lines = results.map((result) => `  ${result.id.padEnd(width)}  ${result.status}`);
  const verdict = gatePasses(results) ? "PHASE 2 GATE: PASS" : "PHASE 2 GATE: NOT MET";
  return [...lines, "", verdict].join("\n");
}

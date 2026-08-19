/**
 * The Phase 7 lifecycle, expressed as steps rather than as a script.
 *
 * The list is data for the same reason `PHASE_2_CHECKS` is: the runner, the
 * manifest and anything that later renders a proof page all read one
 * definition, so a claim cannot appear in a report without a step behind it.
 *
 * Two properties are load-bearing.
 *
 * `writes` marks every step that changes chain state. The runner refuses to
 * begin any of them until every prerequisite has passed, which is what makes
 * "no partial writes" a structural property instead of a discipline.
 *
 * Status is monotonic. A step starts `NOT_RUN` and may only move forward, so a
 * process that dies mid-sequence leaves a journal whose unfinished steps still
 * read `NOT_RUN` or `RUNNING`. There is no path by which a crash produces a
 * `PASS`, and there is no path by which a later write quietly rewrites an
 * earlier failure.
 */

export const PHASE_7_STEPS = [
  {
    id: "chain-identity",
    phase: "PREFLIGHT",
    writes: false,
    claim: "The RPC serves BSC testnet 97 and answers at a known head",
    method: "eth_chainId and eth_blockNumber against the configured endpoint.",
  },
  {
    id: "altana-pins",
    phase: "PREFLIGHT",
    writes: false,
    claim: "Every pinned Altana contract is at its recorded address with its recorded code size",
    method:
      "getCode on the account implementation, KeyStore and Orchestrator. A size change means a redeployment, and every authority claim derived from the old code is stale.",
  },
  {
    id: "relay-health",
    phase: "PREFLIGHT",
    writes: false,
    claim: "The Altana relay is reachable and healthy",
    method: "GET /health on the deployment's relay. There is no direct-submission path for a session.",
  },
  {
    id: "venus-target",
    phase: "PREFLIGHT",
    writes: false,
    claim:
      "The Venus target is the audited contract and the granted selector is dispatched by the code deployed behind it",
    method:
      "Check vUSDT code size, read implementation() and compare with the pinned implementation, then scan the implementation's runtime code for the repayBorrow(uint256) selector.",
  },
  {
    id: "spend-bucket",
    phase: "PREFLIGHT",
    writes: false,
    claim:
      "The account contract still truncates a day-period spend bucket to UTC midnight, and enough of the current bucket remains for the sequence",
    method:
      "Call startOfSpendPeriod(now, Day) on the deployed account implementation, compare with floor(now/86400)*86400, and refuse when the remainder of the bucket is under the sequence budget.",
  },
  {
    id: "deployer-balance",
    phase: "PREFLIGHT",
    writes: false,
    claim: "The deployer key exists and holds enough tBNB for every write in the sequence",
    method: "Derive the address from DEPLOYER_PRIVATE_KEY and read its balance.",
  },
  {
    id: "publication-target",
    phase: "PREFLIGHT",
    writes: false,
    claim:
      "There is a receipt registry to publish to and a base URI a verifier could later fetch the evidence from",
    method:
      "getCode at the configured MandateReceiptRegistry, and require an evidence base URI. A receipt pointing at a path only the publisher can read is not publication.",
  },
  {
    id: "mandate-wallet",
    phase: "PREFLIGHT",
    writes: false,
    claim:
      "The wallet the session will act on holds a vUSDT borrow and the underlying balance the sequence spends",
    method:
      "Read borrowBalanceStored and the USDT balance for the wallet, and require both to cover the at-cap repayment plus the breach attempt.",
  },
  {
    id: "allowance-sizing",
    phase: "PREFLIGHT",
    writes: false,
    claim:
      "The standing allowance is sized to the mandate lifetime, so the spend cap and not the allowance is what rejects the breach",
    method:
      "standingAllowanceFor over the mandate lifetime, then assert the allowance remaining after the at-cap repayment still exceeds the breach amount.",
  },
  {
    id: "reference-agent",
    phase: "TRIAL",
    writes: false,
    claim: "The first reference agent loads and exposes the skill the trial will invoke",
    method: "Construct the health-factor-a executor and assert it declares restore-health-factor.",
  },
  {
    id: "trial-spec",
    phase: "TRIAL",
    writes: false,
    claim: "The question the trial answers is frozen before the trial runs",
    method:
      "Build and validate a TrialSpec, then record its canonical hash. Everything the outcome depends on is inside it or is a hash of something outside it.",
  },
  {
    id: "trial-run",
    phase: "TRIAL",
    writes: false,
    claim: "The agent was asked on a forked chain and its proposal was submitted and observed",
    method: "runTrial against an anvil fork of BSC testnet. No public-chain state is touched.",
  },
  {
    id: "reference-replay",
    phase: "TRIAL",
    writes: false,
    claim:
      "The published verdict is the one the published evidence supports, recomputed without reading the stated result",
    method: "replayEvaluation over the projected artifact, comparing its derived outcome with the recorded one.",
  },
  {
    id: "trial-verdict",
    phase: "TRIAL",
    writes: false,
    claim: "The trial passed, so a receipt may be published and a mandate may be derived from it",
    method: "Require evaluator result PASS and a replay that agrees.",
  },
  {
    id: "publish-receipt",
    phase: "PUBLISH",
    writes: true,
    claim: "The trial outcome is committed publicly before any authority is granted",
    method:
      "publishReceipt on the MandateReceiptRegistry with the bundle hash, the spec hash and the tested authority hash, then re-derive the receipt id from the stored fields.",
  },
  {
    id: "compile-authority",
    phase: "GRANT",
    writes: false,
    claim: "The granted authority is within the tested envelope and compiles to enforceable permissions",
    method:
      "compileAuthority with the tested envelope as the ceiling. A failure is a refusal to grant, never a degraded mandate.",
  },
  {
    id: "standing-approval",
    phase: "GRANT",
    writes: true,
    claim:
      "The lifetime-sized ERC-20 allowance the protocol needs is created by the admin, not by the session",
    method:
      "Admin-path approve(vUSDT, standingAllowance). The session holds no approve permission, so this ceiling only ever decreases.",
  },
  {
    id: "grant-session",
    phase: "GRANT",
    writes: true,
    claim: "A session key bounded to one target, one selector and one daily cap exists on the account",
    method: "grantSession through the Altana relay with the compiled permissions and the mandate expiry.",
  },
  {
    id: "read-enforced-authority",
    phase: "GRANT",
    writes: false,
    claim: "What the account enforces is read from the account, not from the object that was sent to it",
    method:
      "readEnforcedAuthority on the WALLET address: canExecutePackedInfos for the key hash and for the wallet-wide key hash, spendInfos, and getKeys, all pinned to one block.",
  },
  {
    id: "compare-requested-enforced",
    phase: "GRANT",
    writes: false,
    claim:
      "Every difference between what was requested and what is enforced is disclosed, including the Orchestrator permission the wallet layer appends",
    method:
      "diffRequestedVsEnforced, then refuse to continue on any CRITICAL discrepancy. The Orchestrator rule must be present and reported, never filtered out.",
  },
  {
    id: "execute-repay",
    phase: "EXECUTE",
    writes: true,
    claim: "A call inside the granted scope succeeds from the session key",
    method: "execute(session, [{ to: vUSDT, data: repayBorrow(atCapAmount) }]) through the relay.",
  },
  {
    id: "venus-post-state",
    phase: "EXECUTE",
    writes: false,
    claim: "The repayment moved the position by exactly the amount that was spent",
    method:
      "Compare borrowBalanceStored and the wallet's USDT balance before and after, and compare the account's currentSpent with the amount repaid.",
  },
  {
    id: "cap-breach-attempt",
    phase: "REJECT",
    writes: true,
    claim: "A second call in the same UTC bucket that would exceed the cumulative cap is submitted",
    method:
      "Re-read the bucket start first, abandon the step if it moved, then execute repayBorrow(breachAmount) from the session.",
  },
  {
    id: "cap-breach-is-spend-limit",
    phase: "REJECT",
    writes: false,
    claim:
      "The breach was rejected by the account's spend cap with ExceededSpendLimit, and not by an ERC-20 allowance",
    method:
      "Decode the revert. Require isPolicyRejection and the name ExceededSpendLimit; an ALLOWANCE_INSUFFICIENT class fails this step outright, and the on-chain allowance at the moment of the attempt is recorded beside it.",
  },
  {
    id: "wrong-target-attempt",
    phase: "REJECT",
    writes: true,
    claim: "A call outside the granted scope is submitted from the same session",
    method:
      "Execute the granted selector on a different vToken, and a different selector on the granted vToken.",
  },
  {
    id: "wrong-target-rejected",
    phase: "REJECT",
    writes: false,
    claim: "Both out-of-scope calls were rejected by the account with UnauthorizedCall",
    method: "Decode both reverts and require UnauthorizedCall on each.",
  },
  {
    id: "revoke-session",
    phase: "REVOKE",
    writes: true,
    claim: "The session is revoked and the account no longer holds the key",
    method: "revokeSession, then re-read getKeys and report the public KeyStore's view separately.",
  },
  {
    id: "post-revoke-execution-fails",
    phase: "REVOKE",
    writes: true,
    claim: "A previously permitted call fails once the session is revoked",
    method: "Repeat the permitted repayBorrow from the revoked session and require a session-invalid revert.",
  },
  {
    id: "clear-standing-approval",
    phase: "REVOKE",
    writes: true,
    claim: "The one durable effect the mandate created is cleaned up and the allowance reads zero",
    method: "Admin-path approve(vUSDT, 0), then read the allowance back.",
  },
  {
    id: "evidence-artifact",
    phase: "CLOSE",
    writes: false,
    claim: "Every step's transactions, addresses, revert selectors and blocks are collected into one document",
    method: "Assemble the execution record from the journal rather than from a separate narration of it.",
  },
  {
    id: "record-activation",
    phase: "CLOSE",
    writes: true,
    claim:
      "The mandate is recorded against its receipt, with a disclosure URI a verifier can resolve the granted authority from",
    method: "recordActivation on the registry, then re-derive the mandate id from the stored fields.",
  },
  {
    id: "record-revocation",
    phase: "CLOSE",
    writes: true,
    claim:
      "The revocation is on the same public record as the activation, so a reader who finds an empty account can tell a revoked mandate from one that was never granted",
    method:
      "recordRevocation on the registry after the account-side revocation succeeded, then read the stamped revokedAt back out of the emitted event.",
  },
  {
    id: "independent-verifier",
    phase: "CLOSE",
    writes: false,
    claim: "An independent verifier reaches the same conclusion from chain and evidence alone",
    method:
      "Run the verifier's trial and mandate paths in-process against the published ids, with no MANDATE database or API in the path.",
  },
  {
    id: "proof-manifest",
    phase: "CLOSE",
    writes: false,
    claim: "A canonical document carries every hash and address a third party needs to repeat all of this",
    method: "Write the manifest to artifacts/phase-7/ through the canonical encoding.",
  },
] as const;

export type Phase7StepId = (typeof PHASE_7_STEPS)[number]["id"];
export type Phase7Phase = (typeof PHASE_7_STEPS)[number]["phase"];

/**
 * `SKIPPED` is not a synonym for `BLOCKED`.
 *
 * A blocked step is one the environment prevented; a skipped step is one an
 * earlier stop made unreachable. Reporting the second as the first would say
 * the operator has thirty things to fix when they have one.
 */
export type Phase7StepStatus = "NOT_RUN" | "RUNNING" | "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

/** One observable backing a step. Transaction hashes, addresses, selectors, block numbers. */
export interface StepEvidence {
  label: string;
  value: string;
}

export interface Phase7StepResult {
  id: Phase7StepId;
  phase: Phase7Phase;
  writes: boolean;
  status: Phase7StepStatus;
  /** What was actually observed. Empty while the step has not run. */
  observed: string;
  evidence: StepEvidence[];
  /** Unix milliseconds at which the step reached its current status. */
  updatedAt: number;
}

const STATUS_RANK: Record<Phase7StepStatus, number> = {
  NOT_RUN: 0,
  RUNNING: 1,
  PASS: 2,
  FAIL: 2,
  BLOCKED: 2,
  SKIPPED: 2,
};

export function isTerminal(status: Phase7StepStatus): boolean {
  return STATUS_RANK[status] === 2;
}

/**
 * The run's record of itself.
 *
 * Held in memory and written out on every exit path including the failing ones,
 * because the manifest's job is to say where a run stopped and a manifest that
 * only exists on success cannot do that.
 */
export class Phase7Journal {
  private readonly results: Map<Phase7StepId, Phase7StepResult>;

  constructor(private readonly now: () => number = Date.now) {
    this.results = new Map(
      PHASE_7_STEPS.map((step) => [
        step.id,
        {
          id: step.id,
          phase: step.phase,
          writes: step.writes,
          status: "NOT_RUN" as const,
          observed: "",
          evidence: [],
          updatedAt: 0,
        },
      ]),
    );
  }

  get(id: Phase7StepId): Phase7StepResult {
    const result = this.results.get(id);
    if (result === undefined) throw new Error(`unknown Phase 7 step '${id}'`);
    return result;
  }

  /** Mark a step as under way, so a crash inside it is distinguishable from never reaching it. */
  begin(id: Phase7StepId): void {
    this.transition(id, "RUNNING", "", []);
  }

  pass(id: Phase7StepId, observed: string, evidence: readonly StepEvidence[] = []): void {
    this.transition(id, "PASS", observed, evidence);
  }

  fail(id: Phase7StepId, observed: string, evidence: readonly StepEvidence[] = []): void {
    this.transition(id, "FAIL", observed, evidence);
  }

  block(id: Phase7StepId, observed: string, evidence: readonly StepEvidence[] = []): void {
    this.transition(id, "BLOCKED", observed, evidence);
  }

  /** Mark every step still untouched as unreachable, with the reason the run stopped. */
  skipRemaining(observed: string): void {
    for (const result of this.results.values()) {
      if (result.status === "NOT_RUN") this.transition(result.id, "SKIPPED", observed, []);
    }
  }

  /**
   * Move a step forward, or refuse.
   *
   * Backwards and sideways transitions throw rather than being ignored. A run
   * that tries to overwrite a recorded failure has a bug whose whole effect
   * would otherwise be to make a proof read better than the run that produced
   * it.
   */
  private transition(
    id: Phase7StepId,
    status: Phase7StepStatus,
    observed: string,
    evidence: readonly StepEvidence[],
  ): void {
    const current = this.get(id);
    if (STATUS_RANK[status] <= STATUS_RANK[current.status]) {
      throw new Error(
        `refusing to move step '${id}' from ${current.status} to ${status}: step status is monotonic`,
      );
    }
    this.results.set(id, {
      ...current,
      status,
      observed: observed === "" ? current.observed : observed,
      evidence: [...current.evidence, ...evidence],
      updatedAt: this.now(),
    });
  }

  /** Attach an observable to a step that is already under way. */
  record(id: Phase7StepId, ...evidence: StepEvidence[]): void {
    const current = this.get(id);
    this.results.set(id, { ...current, evidence: [...current.evidence, ...evidence] });
  }

  all(): Phase7StepResult[] {
    return PHASE_7_STEPS.map((step) => this.get(step.id));
  }

  /**
   * The first step that has not reached a terminal state.
   *
   * This is what an interrupted run leaves behind for an operator, and it is
   * deliberately not an instruction to resume: the runner never picks up from
   * here on its own, because a resumed write path cannot know what the dead
   * process had already submitted.
   */
  resumePoint(): Phase7StepResult | undefined {
    return this.all().find((result) => !isTerminal(result.status));
  }

  passed(): boolean {
    return this.all().every((result) => result.status === "PASS");
  }
}

export function summarizeSteps(results: readonly Phase7StepResult[]): string {
  const width = Math.max(...PHASE_7_STEPS.map((step) => step.id.length));
  let phase = "";
  const lines: string[] = [];

  for (const result of results) {
    if (result.phase !== phase) {
      phase = result.phase;
      lines.push(`  ${phase}`);
    }
    const marker = result.writes ? "w" : " ";
    lines.push(`  ${marker} ${result.id.padEnd(width)}  ${result.status}`);
  }

  return lines.join("\n");
}

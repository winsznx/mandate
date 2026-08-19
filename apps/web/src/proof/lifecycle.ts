/**
 * The lifecycle, in the order it happened.
 *
 * Nine stages, and the sixth is the one the product exists for. Everything
 * before it is a chain of transactions anyone can follow; the boundary
 * rejections are the point where the mechanism either held or did not, and they
 * are the stage with no transactions in it at all.
 *
 * Stages are assembled from the run record where one is available and from the
 * chain-read report otherwise, and every stage says which. A stage with no
 * evidence renders as "not recorded" rather than disappearing: a missing step in
 * a lifecycle is a finding, and a list that quietly omitted it would read as a
 * complete run.
 */
import type { Hex } from "viem";
import type { EvidenceProvenance, ExecutedEvidence, RejectedIntentEvidence } from "./evidence-kind";
import type { ProofManifestView } from "./documents";
import type { ProofReport } from "./verify";

export interface StageTransaction {
  label: string;
  txHash: Hex;
}

export interface LifecycleStage {
  id: string;
  ordinal: number;
  title: string;
  /** What happened, in a sentence a reader without the vocabulary can follow. */
  summary: string;
  transactions: StageTransaction[];
  /**
   * Refusals belonging to this stage.
   *
   * A separate field from `transactions` rather than a flag on a shared list,
   * so no renderer can iterate one collection and emit explorer links for all
   * of it.
   */
  rejections: RejectedIntentEvidence[];
  detail: { label: string; value: string }[];
  provenance: EvidenceProvenance;
  /** Set when the stage produced nothing, with the reason. */
  missing?: string;
}

/** Run-record step ids that supply each stage's detail lines. */
const STAGE_STEPS: Record<string, readonly string[]> = {
  trial: ["trial-run", "reference-replay", "trial-verdict"],
  receipt: ["publish-receipt"],
  compiled: ["compile-authority"],
  granted: ["grant-session", "read-enforced-authority", "compare-requested-enforced"],
  executed: ["execute-repay", "venus-post-state"],
  rejections: ["cap-breach-attempt", "cap-breach-is-spend-limit", "wrong-target-attempt", "wrong-target-rejected"],
  revoked: ["revoke-session", "record-revocation"],
  postRevoke: ["post-revoke-execution-fails", "clear-standing-approval"],
  verified: ["record-activation", "independent-verifier"],
};

const REJECTION_STAGE: Record<string, "rejections" | "postRevoke"> = {
  SPEND_CAP: "rejections",
  OUT_OF_SCOPE_CALL: "rejections",
  SESSION_INVALID: "postRevoke",
};

/** Run-record evidence keys that hold a transaction hash, and what to call them. */
const TX_EVIDENCE_LABEL: Record<string, string> = {
  publishTxHash: "receipt published to the registry",
  grantTxHash: "session key granted on the account",
  revokeTxHash: "session key revoked",
  clearTxHash: "standing allowance cleared to zero",
  activationTxHash: "activation recorded against the receipt",
  revocationTxHash: "revocation recorded against the activation",
};

const EXECUTION_STAGE: Record<string, string> = {
  "publish-receipt": "receipt",
  "standing-approval": "compiled",
  "grant-session": "granted",
  "execute-repay": "executed",
  "revoke-session": "revoked",
  "clear-standing-approval": "postRevoke",
  "record-activation": "verified",
  "record-revocation": "revoked",
};

export function buildLifecycle(report: ProofReport): LifecycleStage[] {
  const manifest = report.runRecord;
  const provenance: EvidenceProvenance = manifest === undefined ? "CHAIN" : "RUN_RECORD";

  const rejectionsByStage = groupRejections(report.rejected);
  const txByStage = groupTransactions(report, manifest);

  const stages: Array<Omit<LifecycleStage, "ordinal" | "transactions" | "rejections" | "detail">> = [
    {
      id: "trial",
      title: "Trial run against a pinned fork",
      summary: `The agent answered a frozen question on a fork of chain ${report.network.chainId} at block ${report.receipt.snapshotBlock}, and an independent reference model that does not share the agent's accounting recomputed the same answer.`,
      provenance,
    },
    {
      id: "receipt",
      title: "Receipt published",
      summary:
        "The result was written to a registry with no owner, no pause and no upgrade path. The receipt's id recomputes from its own fields, so nothing behind it can be edited without changing the id.",
      provenance: "CHAIN",
    },
    {
      id: "compiled",
      title: "Authority compiled from the tested envelope",
      summary:
        "The grant was derived from what the trial tested rather than from what the application asked for. The compiler also disclosed the standing ERC-20 allowance the mandate would need, which outlives the session and has to be cleared separately.",
      provenance,
    },
    {
      id: "granted",
      title: "Session granted to the wallet's own account",
      summary:
        "A session key was registered on the user's account contract with a bounded permission set. The page then reads back what the account actually enforces, which is not necessarily what was requested.",
      provenance: "CHAIN",
    },
    {
      id: "executed",
      title: "Permitted execution",
      summary:
        "An action inside the granted authority reached the chain and succeeded. It has a transaction, a receipt and a post-state, all of which anyone can fetch.",
      provenance: "CHAIN",
    },
    {
      id: "rejections",
      title: "Boundary crossings refused before broadcast",
      summary:
        "Actions outside the granted authority were refused by the account's own validator. No transaction was produced for any of them, so there is nothing on an explorer to open — the refusal happened earlier than a revert would have.",
      provenance,
    },
    {
      id: "revoked",
      title: "Session revoked",
      summary:
        "The key was removed from the account and from the public KeyStore. Both now answer that it is not held and not valid, and the registry carries the same fact, so a reader who finds an empty account can tell a revoked mandate from one that was never granted.",
      provenance: "CHAIN",
    },
    {
      id: "postRevoke",
      title: "Previously permitted action refused after revocation",
      summary:
        "The same repayment that succeeded earlier was attempted again with the revoked key. The account no longer holds the key, so there was no permission set to check it against. The standing allowance was then cleared.",
      provenance,
    },
    {
      id: "verified",
      title: "Independent verification",
      summary:
        "The activation was recorded against the receipt, and the whole record was re-checked by a verifier that reads only the chain and the disclosed documents.",
      provenance: "CHAIN",
    },
  ];

  return stages.map((stage, index) => {
    const transactions = txByStage[stage.id] ?? [];
    const rejections = rejectionsByStage[stage.id] ?? [];
    const detail = detailFor(stage.id, manifest);

    return {
      ...stage,
      ordinal: index + 1,
      transactions,
      rejections,
      detail,
      ...(transactions.length === 0 && rejections.length === 0 && detail.length === 0
        ? {
            missing:
              manifest === undefined
                ? "The run record was not reachable, so this stage has no recorded evidence on this page. The CLI verifier reads the same stage from chain."
                : "The run record contains no entry for this stage.",
          }
        : {}),
    };
  });
}

function groupRejections(rejections: readonly RejectedIntentEvidence[]): Record<string, RejectedIntentEvidence[]> {
  const grouped: Record<string, RejectedIntentEvidence[]> = {};
  for (const rejection of rejections) {
    const stage = REJECTION_STAGE[rejection.mechanism] ?? "rejections";
    (grouped[stage] ??= []).push(rejection);
  }
  return grouped;
}

function groupTransactions(
  report: ProofReport,
  manifest: ProofManifestView | undefined,
): Record<string, StageTransaction[]> {
  const grouped: Record<string, StageTransaction[]> = {};
  const add = (stage: string, entry: StageTransaction): void => {
    const list = (grouped[stage] ??= []);
    if (!list.some((existing) => existing.txHash.toLowerCase() === entry.txHash.toLowerCase())) {
      list.push(entry);
    }
  };

  for (const executed of report.executed) {
    const stage = stageForExecuted(executed, manifest);
    add(stage, { label: executed.label, txHash: executed.txHash });
  }

  if (manifest !== undefined) {
    for (const step of manifest.steps) {
      const stage = stageOfStep(step.id);
      if (stage === undefined) continue;
      for (const entry of step.evidence ?? []) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(entry.value)) continue;
        const label = TX_EVIDENCE_LABEL[entry.label];
        // Only keys known to hold a transaction hash. Every other 32-byte value
        // in the record is a commitment, and linking one to an explorer would
        // send a reader to a page that does not exist.
        if (label === undefined) continue;
        add(stage, { label, txHash: entry.value as Hex });
      }
    }
  }

  return grouped;
}

function stageForExecuted(executed: ExecutedEvidence, manifest: ProofManifestView | undefined): string {
  const record = manifest?.executions.find(
    (entry) => entry.txHash !== undefined && entry.txHash.toLowerCase() === executed.txHash.toLowerCase(),
  );
  return (record === undefined ? undefined : EXECUTION_STAGE[record.step]) ?? "executed";
}

function stageOfStep(stepId: string): string | undefined {
  for (const [stage, ids] of Object.entries(STAGE_STEPS)) {
    if (ids.includes(stepId)) return stage;
  }
  return undefined;
}

function detailFor(stageId: string, manifest: ProofManifestView | undefined): { label: string; value: string }[] {
  if (manifest === undefined) return [];
  const wanted = STAGE_STEPS[stageId] ?? [];
  return manifest.steps
    .filter((step) => wanted.includes(step.id))
    .map((step) => ({ label: step.id, value: step.observed ?? step.status }));
}

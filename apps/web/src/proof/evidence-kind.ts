/**
 * The two kinds of evidence a mandate produces, and why they may never share a
 * presentation.
 *
 * EXECUTED evidence has a transaction. A third party checks it by fetching that
 * transaction, reading its status and its post-state, and following an explorer
 * link. Nothing about it has to be taken on trust.
 *
 * REJECTED_INTENT evidence has no transaction, and this is the point rather
 * than a gap. The account's own validator evaluated the intent, found it
 * outside the granted authority, and declined to produce a transaction at all.
 * The boundary held one step earlier than a revert would have: a revert means
 * the call reached execution and something rejected it there, having already
 * paid gas and already been ordered into a block. Here the call never became a
 * transaction, so there is nothing on any explorer to link to, and claiming
 * otherwise would misdescribe the guarantee.
 *
 * `claims/ledger.json` binds this: `rejection-produces-no-transaction` is
 * recorded as NOT_CLAIMED_AS_TRANSACTION, with the explicit limitation that
 * MANDATE must not claim to show reverted transactions for blocked actions. The
 * type below enforces it structurally — a `RejectedIntentEvidence` has no field
 * a transaction hash could be written into, so no renderer can produce a link
 * for one even by mistake.
 */
import type { Address, Hex } from "viem";
import { explorerTxUrl } from "./config";
import { formatUnits } from "./format";

/**
 * Where a record came from, and therefore how much it is worth.
 *
 * `CHAIN` is read back from the registry now. `DISCLOSURE` is a document whose
 * granted authority hashes to an on-chain commitment; its execution lists do
 * not, so they are publisher statements that the page re-checks against chain
 * where a transaction exists to re-check. `RUN_RECORD` is the operator's own
 * log, which nothing on chain commits to. The page prints the provenance next
 * to anything sourced from the last of these rather than letting it borrow the
 * authority of the first.
 */
export type EvidenceProvenance = "CHAIN" | "DISCLOSURE" | "RUN_RECORD";

export type ExecutionOutcome = "CONFIRMED" | "REVERTED" | "UNVERIFIED";

export interface ExecutedEvidence {
  kind: "EXECUTED";
  label: string;
  /** The reason this kind exists. A rejection has no equivalent field. */
  txHash: Hex;
  outcome: ExecutionOutcome;
  target?: Address;
  selector?: string;
  amountRaw?: string;
  /** Set when the outcome could not be re-read from chain, so the page can say why. */
  outcomeReason?: string;
  /**
   * The contract the transaction was sent to.
   *
   * Almost never the wallet. A session key submits through a relay, so the
   * sender is the relay's own address and the recipient is the orchestrator
   * that forwards into the account. Recording it stops a reader concluding the
   * user signed this, and stops the page treating a relayed call as suspicious.
   */
  submittedTo?: Address;
  /** True when the transaction emitted an event from a contract inside the granted authority. */
  touchedGrantedTarget?: boolean;
  provenance: EvidenceProvenance;
}

export type RejectionMechanism = "SPEND_CAP" | "OUT_OF_SCOPE_CALL" | "SESSION_INVALID";

export interface RejectedIntentAccountState {
  /** `canExecute` for the attempted (target, selector) at the moment of the attempt. */
  callPermitted?: boolean;
  keyRegistered?: boolean;
  spendCapRaw?: string;
  spentInBucketRaw?: string;
  /**
   * The ERC-20 allowance still standing when the attempt was made.
   *
   * Carries more weight than it looks. An exhausted allowance is the failure
   * most likely to impersonate a spend-cap rejection, and a number here that
   * comfortably covers the request is what rules it out.
   */
  allowanceAtAttemptRaw?: string;
}

export interface RejectedIntentEvidence {
  kind: "REJECTED_INTENT";
  label: string;
  target: Address;
  selector: string;
  amountRaw?: string;
  /** The custom error the account's validator raised, e.g. `ExceededSpendLimit`. */
  validatorError: string;
  mechanism: RejectionMechanism;
  accountState: RejectedIntentAccountState;
  provenance: EvidenceProvenance;
}

export type ProofEvidence = ExecutedEvidence | RejectedIntentEvidence;

/**
 * The only way this page turns evidence into an explorer link.
 *
 * Narrowing on the discriminant means a rejection cannot reach `explorerTxUrl`,
 * and there is no second path that could.
 */
export function explorerUrlFor(evidence: ProofEvidence): string | undefined {
  return evidence.kind === "EXECUTED" ? explorerTxUrl(evidence.txHash) : undefined;
}

export function isExecuted(evidence: ProofEvidence): evidence is ExecutedEvidence {
  return evidence.kind === "EXECUTED";
}

export function isRejectedIntent(evidence: ProofEvidence): evidence is RejectedIntentEvidence {
  return evidence.kind === "REJECTED_INTENT";
}

/** One sentence a reader without the vocabulary can still act on. */
export function decodedReason(evidence: RejectedIntentEvidence): string {
  switch (evidence.mechanism) {
    case "SPEND_CAP":
      return "The account added the requested amount to what this key had already spent in the current UTC day bucket, found the total above the granted cap, and refused to produce a transaction.";
    case "OUT_OF_SCOPE_CALL":
      return "The account looked up this contract and this function in the key's permission set, did not find them, and refused to produce a transaction.";
    case "SESSION_INVALID":
      return "The account no longer holds this key, so there was no permission set to check the call against, and it refused to produce a transaction.";
  }
}

export interface SpendArithmetic {
  capRaw: string;
  spentRaw: string;
  requestedRaw: string;
  wouldTotalRaw: string;
  overByRaw: string;
}

/**
 * The subtraction a reader would do by hand.
 *
 * Shown rather than asserted, because "the cap was exceeded" is a claim and
 * `20 + 6 = 26 > 25` is a calculation the reader completes themselves.
 */
export function spendArithmetic(evidence: RejectedIntentEvidence): SpendArithmetic | undefined {
  const { spendCapRaw, spentInBucketRaw } = evidence.accountState;
  if (spendCapRaw === undefined || spentInBucketRaw === undefined || evidence.amountRaw === undefined) {
    return undefined;
  }

  const cap = BigInt(spendCapRaw);
  const spent = BigInt(spentInBucketRaw);
  const requested = BigInt(evidence.amountRaw);
  const total = spent + requested;

  return {
    capRaw: spendCapRaw,
    spentRaw: spentInBucketRaw,
    requestedRaw: evidence.amountRaw,
    wouldTotalRaw: total.toString(10),
    overByRaw: (total > cap ? total - cap : 0n).toString(10),
  };
}

/**
 * Whether the standing ERC-20 allowance can be ruled out as the real cause.
 *
 * Undefined when the record does not carry the allowance, because "we did not
 * measure it" and "it was not the constraint" are different statements.
 */
export function allowanceRuledOut(evidence: RejectedIntentEvidence): boolean | undefined {
  const { allowanceAtAttemptRaw } = evidence.accountState;
  if (allowanceAtAttemptRaw === undefined || evidence.amountRaw === undefined) return undefined;
  return BigInt(allowanceAtAttemptRaw) >= BigInt(evidence.amountRaw);
}

export function formatAmount(raw: string, decimals: number, symbol: string): string {
  return `${formatUnits(raw, decimals)} ${symbol}`;
}

/** A record the page refuses to render, and the reason, so nothing is silently dropped. */
export interface MalformedEvidence {
  kind: "MALFORMED";
  label: string;
  reason: string;
}

export interface RawExecutionRecord {
  step: string;
  label: string;
  status: string;
  target: string;
  selector: string;
  amountRaw?: string | undefined;
  txHash?: string | undefined;
}

export interface RejectionContext {
  /** `ExceededSpendLimit`, `UnauthorizedCall`, … keyed by the step that produced it. */
  validatorErrorByStep: Record<string, string>;
  mechanismByStep: Record<string, RejectionMechanism>;
  accountStateByStep: Record<string, RejectedIntentAccountState>;
}

/**
 * Classify one execution record from the run log.
 *
 * The classification is on the presence of a transaction hash, never on the
 * label or the step name, because the transaction is the actual difference
 * between the two guarantees. A record that claims to have reverted while
 * carrying a hash is a genuine reverted transaction and keeps its link; a
 * record with no hash is a refusal that never reached the chain.
 *
 * Contradictions are surfaced rather than coerced. A rejection whose mechanism
 * the log does not state is returned as MALFORMED, because guessing one would
 * put a sentence on the page that no evidence supports.
 */
export function classifyExecutionRecord(
  record: RawExecutionRecord,
  context: RejectionContext,
): ProofEvidence | MalformedEvidence {
  const hasTx = typeof record.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(record.txHash);

  if (hasTx) {
    return {
      kind: "EXECUTED",
      label: record.label,
      txHash: record.txHash as Hex,
      outcome: record.status === "SUCCESS" ? "CONFIRMED" : "REVERTED",
      target: record.target.toLowerCase() as Address,
      selector: record.selector,
      ...(record.amountRaw === undefined ? {} : { amountRaw: record.amountRaw }),
      provenance: "RUN_RECORD",
    };
  }

  if (record.status === "SUCCESS") {
    return {
      kind: "MALFORMED",
      label: record.label,
      reason: "the run log records a successful execution with no transaction hash, which cannot both be true",
    };
  }

  const mechanism = context.mechanismByStep[record.step];
  const validatorError = context.validatorErrorByStep[record.step];
  if (mechanism === undefined || validatorError === undefined) {
    return {
      kind: "MALFORMED",
      label: record.label,
      reason: `the run log records a refusal at step "${record.step}" but states no validator error for it, so the page cannot say what refused it`,
    };
  }

  return {
    kind: "REJECTED_INTENT",
    label: record.label,
    target: record.target.toLowerCase() as Address,
    selector: record.selector,
    ...(record.amountRaw === undefined ? {} : { amountRaw: record.amountRaw }),
    validatorError,
    mechanism,
    accountState: context.accountStateByStep[record.step] ?? {},
    provenance: "RUN_RECORD",
  };
}

export function partitionEvidence(items: readonly (ProofEvidence | MalformedEvidence)[]): {
  executed: ExecutedEvidence[];
  rejected: RejectedIntentEvidence[];
  malformed: MalformedEvidence[];
} {
  const executed: ExecutedEvidence[] = [];
  const rejected: RejectedIntentEvidence[] = [];
  const malformed: MalformedEvidence[] = [];

  for (const item of items) {
    if (item.kind === "EXECUTED") executed.push(item);
    else if (item.kind === "REJECTED_INTENT") rejected.push(item);
    else malformed.push(item);
  }

  return { executed, rejected, malformed };
}

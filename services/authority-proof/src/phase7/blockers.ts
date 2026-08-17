/**
 * Why a Phase 7 run refused to start, in a form an operator can act on.
 *
 * There is exactly one shape for a refusal, and it is fixed so it stays
 * greppable across CI logs, terminal scrollback and screenshots. The first
 * three lines never vary; everything after them is the detail that particular
 * reason needs and nothing else.
 *
 * Two classes of blocker exist because they call for different responses.
 * A blocker that `haltsRun` means the world is not what MANDATE analysed — a
 * redeployed contract, the wrong chain, a spend bucket that no longer truncates
 * to UTC midnight — and continuing would produce evidence about a system nobody
 * described. A blocker that only `haltsWrites` means the operator is missing an
 * input the read-only lane does not need, so the run keeps going, does every
 * check that costs nothing, and stops at the first state-changing call.
 */

export const BLOCK_REASONS = [
  /** No `DEPLOYER_PRIVATE_KEY`, so nothing can be signed. */
  "MISSING_DEPLOYER_KEY",
  /** The key exists but cannot pay for the sequence. */
  "INSUFFICIENT_DEPLOYER_BALANCE",
  /** A pinned Altana or Venus contract no longer matches its recorded code size. */
  "PINNED_CONTRACT_CHANGED",
  /** The relay is the only submission path; without it no session can act. */
  "RELAY_UNHEALTHY",
  /** The RPC serves a different chain than the one the proof is pinned to. */
  "WRONG_CHAIN",
  /** The RPC did not answer at all. */
  "RPC_UNREACHABLE",
  /** `vUSDT.implementation()` moved, so the audited analysis no longer describes the target. */
  "VENUS_IMPLEMENTATION_CHANGED",
  /** The granted selector is not dispatched by the code deployed at the target. */
  "VENUS_SELECTOR_ABSENT",
  /** On-chain `startOfSpendPeriod` no longer truncates a day to UTC midnight. */
  "SPEND_BUCKET_SEMANTICS_CHANGED",
  /** Too little of the current UTC day remains for the sequence to finish inside it. */
  "BUCKET_ROLLOVER_TOO_CLOSE",
  /** No `MandateReceiptRegistry` deployed where the run was told to publish. */
  "MISSING_RECEIPT_REGISTRY",
  /** No wallet to grant a session on. */
  "MISSING_MANDATE_WALLET",
  /** The wallet holds no vUSDT debt large enough for the demo sequence. */
  "INSUFFICIENT_VENUS_DEBT",
  /** The wallet cannot fund the repayments the sequence performs. */
  "INSUFFICIENT_UNDERLYING_BALANCE",
  /**
   * The standing allowance would run out before the spend cap does.
   *
   * The cap-breach step would then revert on the ERC-20 allowance and the run
   * would prove a misconfiguration while appearing to work.
   */
  "ALLOWANCE_TOO_SMALL_FOR_BREACH",
  /** Nowhere to publish evidence a verifier could later fetch. */
  "MISSING_EVIDENCE_BASE_URI",
  /** The reference agent could not be constructed, so there is nothing to trial. */
  "REFERENCE_AGENT_UNAVAILABLE",
  /** No `anvil` on PATH, so no fork and no trial. */
  "ANVIL_UNAVAILABLE",
  /**
   * The trial could not run at all.
   *
   * Not a failing agent. A run that never happened produces no evidence, so
   * there is nothing for a receipt to commit to and nothing worth continuing to.
   */
  "TRIAL_DID_NOT_RUN",
] as const;

export type BlockReason = (typeof BLOCK_REASONS)[number];

export interface Blocker {
  reason: BlockReason;
  /** Ordered `key: value` lines printed under the reason. */
  detail: ReadonlyArray<readonly [string, string]>;
  /** True when the run must not proceed even through read-only steps. */
  haltsRun: boolean;
}

/**
 * A blocker that invalidates the whole run.
 *
 * Everything downstream would be describing a chain that is not the one the
 * proof claims to be about, so no evidence is produced at all.
 */
export function fatalBlocker(
  reason: BlockReason,
  detail: ReadonlyArray<readonly [string, string]>,
): Blocker {
  return { reason, detail, haltsRun: true };
}

/**
 * A blocker that stops the writes and nothing else.
 *
 * The read-only lane still runs: preflight, the trial, the reference replay and
 * the evidence bundle all cost nothing and are worth having before a key
 * arrives.
 */
export function writeBlocker(
  reason: BlockReason,
  detail: ReadonlyArray<readonly [string, string]>,
): Blocker {
  return { reason, detail, haltsRun: false };
}

export interface NetworkLabel {
  name: string;
  chainId: number;
}

/**
 * The refusal stanza, byte for byte.
 *
 * Deliberately not a template an operator has to interpret. A run that stops
 * here has performed no write, so this text plus the chain is the entire state
 * of the world.
 */
export function renderBlocked(blocker: Blocker, network: NetworkLabel): string {
  return [
    "BLOCKED",
    `reason: ${blocker.reason}`,
    `network: ${network.name} (${network.chainId})`,
    ...blocker.detail.map(([key, value]) => `${key}: ${value}`),
  ].join("\n");
}

/**
 * The blocker to report when several fired.
 *
 * A run-halting blocker outranks a write-halting one because it describes a
 * world the operator has to fix before anything else is worth reading. Within a
 * class the first one found wins, and the ordering of the checks is therefore
 * part of the contract rather than incidental.
 */
export function primaryBlocker(blockers: readonly Blocker[]): Blocker | undefined {
  return blockers.find((blocker) => blocker.haltsRun) ?? blockers[0];
}

export function haltsRun(blockers: readonly Blocker[]): boolean {
  return blockers.some((blocker) => blocker.haltsRun);
}

/**
 * The document a third party repeats the run from.
 *
 * Written on every exit path, including the ones where the run died in the
 * middle. A manifest that only appeared on success would be missing exactly when
 * it is most needed: after a crash between two writes, when the operator has to
 * find out what exists on chain before touching anything else. So the manifest
 * carries the step journal verbatim, names the step that never reached a
 * terminal state, and lists the on-chain identifiers worth reading.
 *
 * It records no resume instruction. The runner will not pick a write sequence
 * back up on its own, because a process that died between submitting a
 * transaction and seeing its receipt cannot know which of the two it did, and
 * guessing means either a duplicate grant or a mandate nobody revokes.
 *
 * Paths are repo-relative. An absolute path in a published document names a
 * directory on one laptop and is worthless to everyone else.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import type { Hex } from "viem";
import type { RejectionMechanism } from "./attribution.js";
import type { Blocker } from "./blockers.js";
import type { Phase7Config } from "./config.js";
import type { AccountRejection } from "./expect-rejection.js";
import type { PreflightFacts } from "./preflight.js";
import { roleRecord } from "./roles.js";
import type { Phase7StepResult } from "./steps.js";

export const PHASE_7_MANIFEST_SCHEMA_VERSION = "mandate.phase-7-proof/1" as const;
export const MANIFEST_FILENAME = "proof-manifest.json";
export const DISCLOSURE_FILENAME = "mandate-disclosure.json";
export const ARTIFACT_ROOT_RELATIVE = "artifacts/phase-7";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Run status, distinguished from the step statuses it summarises.
 *
 * `BLOCKED` means a prerequisite was missing and nothing was written.
 * `INCOMPLETE` means the run stopped part-way through, which is the only status
 * under which chain state may exist that no step recorded a terminal result for.
 */
export type Phase7RunStatus = "PASS" | "FAILED" | "BLOCKED" | "INCOMPLETE";

export interface TrialSummary {
  trialSpecHash: Hex;
  testedAuthorityHash: Hex;
  /** Canonical hash of the bundle. The value a receipt's `evidenceHash` must carry. */
  evidenceBundleHash: Hex;
  trialEvidenceHash: Hex;
  scenarioHash: Hex;
  forkBlock: string;
  rpcSourceClass: string;
  result: string;
  replayDerived: string;
}

export interface ReceiptSummary {
  receiptId: Hex;
  publishTxHash: Hex;
  evidenceURI: string;
  publisher: string;
}

export interface MandateSummary {
  mandateId: Hex;
  grantedAuthorityHash: Hex;
  sessionKeyHash: Hex;
  sessionKeyId: Hex;
  sessionPublicKey: Hex;
  wallet: string;
  expiry: number;
  /**
   * The window the activation committed to on chain.
   *
   * Read back from the account rather than copied from the grant request, and
   * carried here so the manifest and the registry cannot disagree about what
   * was granted.
   */
  validFrom: number;
  validUntil: number;
  disclosureURI: string;
  grantTxHash?: Hex;
  revokeTxHash?: Hex;
  activationTxHash?: Hex;
  /** Zero-free: absent means the registry holds no revocation for this mandate. */
  revokedAt?: number;
  revocationTxHash?: Hex;
}

/**
 * What the account itself said about an intent it refused.
 *
 * Carried on the record because a refusal is rejected during validation and
 * never becomes a transaction, so there is no hash anyone can fetch and the
 * account's own state at the attempt is the only evidence there is. Read before
 * the attempt rather than reconstructed from the outcome, which is what makes
 * it a check on the claim rather than a retelling of it.
 *
 * `validatorError` is optional because neither route to it is guaranteed: the
 * relay does not always surface revert bytes, and a call the relay refuses
 * outright never reaches the account's validator at all. An absent name is a
 * real answer, and a refusal carrying none is left out of the published
 * disclosure rather than given a plausible one.
 */
export interface RejectionAttribution {
  /** The custom error the account's validator raised, when one was recovered. */
  validatorError?: AccountRejection;
  /** What the account's own state at the attempt says refused the call. */
  mechanism: RejectionMechanism;
  accountState: {
    callPermitted: boolean;
    keyRegistered: boolean;
    /** Base units, decimal. The enforced cap for the token being moved. */
    spendCapRaw: string;
    spentInBucketRaw: string;
    /** The figure that rules an exhausted ERC-20 approval out as the cause. */
    allowanceAtAttemptRaw: string;
  };
}

/** One submitted call and what the chain did with it. */
export interface ExecutionRecord {
  step: string;
  label: string;
  target: string;
  selector: string;
  amountRaw?: string;
  txHash?: Hex;
  status: "SUCCESS" | "REVERTED" | "NOT_SUBMITTED";
  blockNumber?: string;
  revertSelector?: string;
  revertName?: string;
  revertClass?: string;
  /** Set only on a call the account refused before broadcast. */
  attribution?: RejectionAttribution;
}

export interface VerifierSummary {
  trialVerdict: string;
  mandateVerdict: string;
  trialExitCode: number;
  mandateExitCode: number;
}

export interface ManifestInput {
  runId: string;
  config: Phase7Config;
  status: Phase7RunStatus;
  startedAt: number;
  finishedAt: number;
  blockers: readonly Blocker[];
  steps: readonly Phase7StepResult[];
  facts: PreflightFacts;
  resumePoint?: Phase7StepResult | undefined;
  trial?: TrialSummary | undefined;
  receipt?: ReceiptSummary | undefined;
  mandate?: MandateSummary | undefined;
  executions: readonly ExecutionRecord[];
  verifier?: VerifierSummary | undefined;
  /** Repo-relative paths of everything this run wrote. */
  artifacts: readonly string[];
}

/**
 * Include a section only when the run produced one.
 *
 * An absent section reads as "this never happened"; a present one full of nulls
 * reads as "this happened and produced nothing", and the two are different
 * claims about a proof.
 */
function optional<T>(
  key: string,
  value: T | undefined,
  project: (value: T) => CanonicalValue,
): Record<string, CanonicalValue> {
  return value === undefined ? {} : { [key]: project(value) };
}

/**
 * Build the manifest.
 *
 * Every wide integer travels as a decimal string. The canonical encoder rejects
 * numbers above 2^53, and a spend cap in base units on BSC crosses that on the
 * first value MANDATE would ever publish.
 */
export function buildManifest(input: ManifestInput): CanonicalValue {
  const facts = input.facts;

  return {
    schemaVersion: PHASE_7_MANIFEST_SCHEMA_VERSION,
    runId: input.runId,
    status: input.status,
    network: { name: input.config.networkName, chainId: input.config.chainId },
    rpcUrl: input.config.rpcUrl,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    writesConfirmed: input.config.confirmed,

    blockers: input.blockers.map((blocker) => ({
      reason: blocker.reason,
      haltsRun: blocker.haltsRun,
      detail: Object.fromEntries(blocker.detail.map(([key, value]) => [key, value])),
    })),

    steps: input.steps.map((step) => ({
      id: step.id,
      phase: step.phase,
      writes: step.writes,
      status: step.status,
      observed: step.observed,
      evidence: step.evidence.map((entry) => ({ label: entry.label, value: entry.value })),
    })),

    // Named so an operator who lost the process still knows which step was in
    // flight, and therefore what to read on chain before doing anything else.
    ...optional("resumePoint", input.resumePoint, (step) => ({
      step: step.id,
      phase: step.phase,
      writes: step.writes,
      status: step.status,
    })),
    autoResume: false,
    autoResumeNote:
      "This run never resumes a write sequence. Read the on-chain state named below, decide what exists, and start a fresh run.",

    chain: {
      observedChainId: facts.observedChainId,
      blockNumber: facts.blockNumber.toString(10),
      relayStatus: facts.relayStatus,
      relayUrl: input.config.altana.relayUrl,
    },

    pinned: {
      altanaAccountImplementation: input.config.altana.accountImplementation,
      altanaKeyStore: input.config.altana.keyStore,
      altanaOrchestrator: input.config.altana.orchestrator,
      venusComptroller: input.config.venus.comptroller,
      venusVToken: input.config.venus.vToken,
      venusVTokenImplementation: facts.vTokenImplementation ?? input.config.venus.vTokenImplementation,
      venusUnderlying: input.config.venus.underlying,
      contracts: facts.pinnedContracts.map((contract) => ({
        label: contract.label,
        address: contract.address,
        observedCodeSize: contract.sizeBytes,
        expectedCodeSize: contract.expected,
      })),
    },

    ...optional("spendBucket", facts.bucket, (bucket) => ({
      periodEnum: 2,
      period: "day",
      bucketStart: bucket.bucketStart.toString(10),
      bucketEnd: bucket.bucketEnd.toString(10),
      remainingSecondsAtStart: bucket.remainingSeconds,
      semanticsMatchUtcMidnight: bucket.semanticsMatchUtcMidnight,
      pinnedVectorResult: bucket.pinnedVectorResult.toString(10),
    })),

    allowance: {
      standingAllowanceRaw: facts.allowance.standingAllowance.toString(10),
      remainingAfterAtCapRaw: facts.allowance.remainingAfterAtCap.toString(10),
      headroomRaw: facts.allowance.headroom.toString(10),
      capBindsBreach: facts.allowance.capBindsBreach,
      note:
        "Sized to the mandate lifetime, not to one period. If this were sized to the daily cap the breach would revert on the ERC-20 allowance and the run would prove a misconfiguration.",
    },

    agent: {
      identityRegistry: input.config.identityRegistry,
      agentId: input.config.agentId,
      registrationUri: input.config.agentRegistrationUri,
      registered: input.config.agentId !== "0",
    },

    // The three parties, named. Present as soon as both keys resolved, and
    // absent rather than half-filled when they did not, because a role block
    // missing a party reads as "there was no agent" and that is the one thing a
    // reader must never have to guess at.
    ...optional("roles", facts.roles, (addresses) => roleRecord(addresses)),

    ...optional("owner", facts.ownerAddress, (address) => ({
      address,
      role: "owner",
      balanceWei: (facts.ownerBalanceWei ?? 0n).toString(10),
      note:
        "Funds every write, including the relay fee for the agent's executions: an Altana session is sponsored out of the wallet it acts on, so no tBNB is ever sent to the agent's key.",
    })),

    ...optional("trial", input.trial, (trial) => ({ ...trial } as unknown as CanonicalValue)),
    ...optional("receipt", input.receipt, (receipt) => ({ ...receipt } as unknown as CanonicalValue)),
    ...optional("mandate", input.mandate, (mandate) => ({ ...mandate } as unknown as CanonicalValue)),
    ...optional("verifier", input.verifier, (verifier) => ({ ...verifier } as unknown as CanonicalValue)),

    executions: input.executions.map((record) => ({ ...record } as unknown as CanonicalValue)),
    artifacts: [...input.artifacts],
  } as CanonicalValue;
}

export interface WrittenManifest {
  /** Repo-relative, so the value is portable and the same on every checkout. */
  relativePath: string;
  absolutePath: string;
}

export function artifactDirectoryFor(runId: string): { relative: string; absolute: string } {
  const relative = `${ARTIFACT_ROOT_RELATIVE}/${runId}`;
  return { relative, absolute: join(repoRoot, relative) };
}

/** Write a canonical document into the run's artifact directory. */
export function writeArtifact(runId: string, filename: string, document: CanonicalValue): string {
  const directory = artifactDirectoryFor(runId);
  const path = join(directory.absolute, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canonicalize(document), "utf8");
  return `${directory.relative}/${filename}`;
}

export function writeManifest(input: ManifestInput): WrittenManifest {
  const directory = artifactDirectoryFor(input.runId);
  const relativePath = writeArtifact(input.runId, MANIFEST_FILENAME, buildManifest(input));
  return { relativePath, absolutePath: join(directory.absolute, MANIFEST_FILENAME) };
}

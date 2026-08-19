/**
 * The whole verification, run on the server for one page load.
 *
 * The rule this file exists to honour: a judge with a browser must be able to
 * reach a verdict. There is no MANDATE API here, no indexer and no database.
 * The registry is read for commitments, the URIs it stores are dereferenced for
 * the documents those commitments name, and every relation is recomputed from
 * the same packages the CLI verifier recomputes it from.
 *
 * One limit is reported rather than papered over. The reference model is hashed
 * from its own source and replaying it needs that source, which a page does not
 * have, so the replay is a SKIP with the reason stated and not a green tick.
 *
 * The mandate's own lifecycle is no longer such a limit. The activation records
 * the window the session was valid over and the moment it was revoked, so a
 * finished mandate is reconstructed from the record instead of being guessed at
 * from an account that now holds nothing.
 */
import { readEnforcedAuthority } from "@mandate/altana";
import { cache } from "react";
import { authorityHash, isSubset } from "@mandate/authority-ir";
import type { SubsetResult } from "@mandate/authority-ir";
import { canonicalHash } from "@mandate/domain/canonical";
import type { CanonicalValue } from "@mandate/domain/canonical";
import { deriveMandateId } from "@mandate/domain";
import type { AuthorityIR } from "@mandate/domain/schemas";
import type { Address, Hex, PublicClient } from "viem";
import { CHAIN_ID, NETWORK_NAME, registryAddress, rpcUrl } from "./config";
import {
  artifactCheckCount,
  artifactResult,
  checkIntegrity,
  DocumentUnavailableError,
  EvidenceBundleViewSchema,
  fetchBytes,
  fetchJsonDocument,
  MandateDisclosureViewSchema,
  parseJsonDocument,
  ProofManifestViewSchema,
} from "./documents";
import type { EvidenceBundleView, MandateDisclosureView, ProofManifestView } from "./documents";
import { classifyExecutionRecord, partitionEvidence } from "./evidence-kind";
import type {
  ExecutedEvidence,
  MalformedEvidence,
  ProofEvidence,
  RejectedIntentAccountState,
  RejectionContext,
  RejectionMechanism,
  RejectedIntentEvidence,
} from "./evidence-kind";
import { mandateLabel } from "./format";
import {
  ChainUnreachableError,
  publicClient,
  readActivation,
  readChainId,
  readReceipt,
  recomputeReceiptId,
  UnknownMandateError,
} from "./registry";
import type { OnChainActivation, OnChainReceipt } from "./registry";
import { decideVerdict, fail, orderSteps, pass, skip, verdictExplanation } from "./steps";
import type { Step, Verdict } from "./steps";
import { buildSubsetView } from "./subset";
import type { SubsetView } from "./subset";

/** ERC-8004 identity registries are ERC-721s, so ownership is how existence is probed. */
const ERC721_ABI = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * Renewal sequences searched when recomputing a mandate id.
 *
 * The Activation record does not store the sequence, so it has to be found by
 * trial. A bounded scan keeps a failure meaningful: 256 renewals of one mandate
 * is far outside any real lifecycle.
 */
const MAX_SEQUENCE_SCAN = 256;

export interface DocumentStatus {
  uri: string;
  /** Set when the document could not be fetched or read. Rendered verbatim. */
  problem?: string;
  /** How the bytes related to the committed hash, when there was one to check. */
  encoding?: "CANONICAL_BYTES" | "RECANONICALISED";
  byteLength?: number;
}

export interface ReceiptSummary {
  receiptId: Hex;
  publisher: Address;
  identityRegistry: Address;
  agentId: string;
  agentVersionHash: Hex;
  evidenceURI: string;
  evidenceHash: Hex;
  testedAuthorityHash: Hex;
  passed: boolean;
  createdAt: number;
  freshUntil: number;
  publishedAt: number;
  snapshotBlock: string;
}

export interface MandateSummary {
  mandateId: Hex;
  label: string;
  wallet: Address;
  sessionKeyHash: Hex;
  grantedAuthorityHash: Hex;
  attestedBy: Address;
  activatedAt: number;
  /** The window the session was granted over, as the activation committed to it. */
  validFrom: number;
  validUntil: number;
  /** Zero when the registry holds no revocation for this mandate. */
  revokedAt: number;
  disclosureURI: string;
  /** Renewal sequence recovered by recomputing the id, when it could be recovered. */
  sequence?: number;
}

export interface SpendWindow {
  period: string;
  bucketStart: number;
  bucketEnd: number;
  /**
   * True when the run confirmed the account's bucket is calendar-aligned.
   *
   * Disclosed rather than hidden. A calendar bucket hard-resets at midnight
   * UTC, so a cap that is nearly exhausted at 23:59 is fully available at
   * 00:01. That boundary is a property of the enforcement a reader has to plan
   * around, and calling the window "rolling" would conceal it.
   */
  calendarAligned: boolean;
}

export interface ProofReport {
  subject: { mandateId: Hex; label: string };
  network: { chainId: number; name: string; rpcUrl: string; registry: Address; observedChainId: number };
  receipt: ReceiptSummary;
  mandate: MandateSummary;
  documents: { evidence: DocumentStatus; disclosure: DocumentStatus; runRecord: DocumentStatus };
  testedAuthority?: AuthorityIR;
  grantedAuthority?: AuthorityIR;
  subsetView?: SubsetView;
  subsetResult?: SubsetResult;
  executed: ExecutedEvidence[];
  rejected: RejectedIntentEvidence[];
  malformed: MalformedEvidence[];
  spendWindow?: SpendWindow;
  runRecord?: ProofManifestView;
  trialResult?: "PASS" | "FAIL";
  steps: Step[];
  verdict: Verdict;
  verdictExplanation: string;
  notes: string[];
  /** Unix seconds at which the page read the chain. Printed so a stale render is visible. */
  observedAt: number;
}

export { ChainUnreachableError, UnknownMandateError };

interface MandateContext {
  client: PublicClient;
  registry: Address;
  activation: OnChainActivation;
  observedChainId: number;
}

/**
 * The cheap half of the read: does this mandate exist, and is the endpoint the
 * right chain.
 *
 * Split out and memoised for the request so the route can answer "no such
 * mandate" with a 404 before it commits a streaming response. A page that
 * flushed its shell first would have to serve the not-found copy under a 200,
 * and a proof surface that reports "found" in its status line while its body
 * says "not found" is exactly the kind of contradiction this product exists to
 * make impossible.
 *
 * `cache` deduplicates across `generateMetadata` and the render, so the extra
 * certainty costs no extra round trip.
 */
export const resolveMandate = cache(async (mandateId: Hex): Promise<MandateContext> => {
  const client = publicClient();
  const registry = registryAddress();

  const observedChainId = await readChainId(client);
  if (observedChainId !== CHAIN_ID) {
    throw new ChainUnreachableError(
      rpcUrl(),
      `the endpoint answered for chain ${observedChainId}, but this proof is published on chain ${CHAIN_ID}. Nothing read from it would describe this mandate.`,
    );
  }

  const activation = await readActivation(client, { registry, mandateId });
  return { client, registry, activation, observedChainId };
});

/**
 * Load and verify one mandate.
 *
 * Throws only when there is nothing to render at all: the endpoint did not
 * answer, or the registry does not know the id. Everything else — an
 * unreachable document, a document that does not parse, a step that cannot be
 * checked — becomes a reported step or a stated problem, because a partial
 * result is information and a blank page is not.
 */
export async function loadProof(mandateId: Hex, now: number): Promise<ProofReport> {
  const { client, registry, activation, observedChainId } = await resolveMandate(mandateId);
  const receipt = await readReceipt(client, { registry, receiptId: activation.trialReceiptId });

  const evidence = await loadEvidence(receipt);
  const disclosure = await loadDisclosure(activation);
  const runRecord = await loadRunRecord(receipt.evidenceURI);

  const identity = await probeIdentity(client, receipt);
  const bundle = evidence.bundle;
  const granted = disclosure.value?.grantedAuthority;

  const sequence = recoverSequence(mandateId, activation);
  const grantedStep = stepGrantedAuthority(mandateId, activation, sequence, granted, disclosure.status.problem);
  const grantAuthenticated = grantedStep.status === "PASS";

  const subsetResult =
    bundle !== undefined && granted !== undefined && grantAuthenticated
      ? isSubset(granted, bundle.testedAuthority)
      : undefined;

  const sessionStep = await stepSessionRegistration(client, activation, disclosure.value, now);

  const evidenceItems = collectEvidence(disclosure.value, runRecord.value);
  // Only a grant the chain vouches for may widen what counts as a permitted
  // target, so an unauthenticated disclosure contributes none.
  const grantedTargets = new Set(
    grantAuthenticated ? (granted?.calls ?? []).map((call) => call.target.toLowerCase()) : [],
  );
  const executedChecked = await Promise.all(
    evidenceItems.executed.map((item) => confirmExecution(client, grantedTargets, item)),
  );

  const steps = orderSteps(
    [
      stepTrialReceipt(activation.trialReceiptId, receipt, bundle),
      stepAgentIdentity(receipt, bundle, identity),
      stepAgentVersion(receipt, bundle),
      stepEvidenceHash(receipt, evidence),
      stepReferenceResult(receipt, bundle),
      stepTestedAuthority(receipt, bundle, evidence.poisoned),
      grantedStep,
      stepSubsetRelation(bundle, granted, grantAuthenticated, subsetResult),
      sessionStep,
      stepAllowedExecution(executedChecked, disclosure.value !== undefined),
      stepBlockedExecution(disclosure.value),
      stepRejectedIntents(evidenceItems.rejected, evidenceItems.malformed, disclosure.value !== undefined),
    ],
    "not reached",
  );

  const stale = now > Number(receipt.freshUntil);
  const verdict = decideVerdict({ steps, stale });
  const spendWindow = spendWindowOf(runRecord.value);
  const trialResult = bundle === undefined ? undefined : artifactResult(bundle.artifact);

  return {
    subject: { mandateId, label: mandateLabel(mandateId) },
    network: { chainId: CHAIN_ID, name: NETWORK_NAME, rpcUrl: rpcUrl(), registry, observedChainId },
    receipt: summariseReceipt(activation.trialReceiptId, receipt),
    mandate: summariseMandate(mandateId, activation, sequence),
    documents: {
      evidence: evidence.status,
      disclosure: disclosure.status,
      runRecord: runRecord.status,
    },
    ...(bundle === undefined ? {} : { testedAuthority: bundle.testedAuthority }),
    ...(granted === undefined ? {} : { grantedAuthority: granted }),
    ...(bundle !== undefined && granted !== undefined
      ? { subsetView: buildSubsetView(granted, bundle.testedAuthority) }
      : {}),
    ...(subsetResult === undefined ? {} : { subsetResult }),
    executed: executedChecked,
    rejected: evidenceItems.rejected,
    malformed: evidenceItems.malformed,
    ...(runRecord.value === undefined ? {} : { runRecord: runRecord.value }),
    ...(spendWindow === undefined ? {} : { spendWindow }),
    ...(trialResult === undefined ? {} : { trialResult }),
    steps,
    verdict,
    verdictExplanation: verdictExplanation(verdict, steps, Number(receipt.freshUntil)),
    notes: buildNotes(evidence, disclosure, runRecord),
    observedAt: now,
  };
}

// --- documents -------------------------------------------------------------

interface EvidenceState {
  status: DocumentStatus;
  bundle?: EvidenceBundleView;
  integrityReason?: string;
  /** True once a hash mismatch has ruled the document out entirely. */
  poisoned: boolean;
}

async function loadEvidence(receipt: OnChainReceipt): Promise<EvidenceState> {
  const uri = receipt.evidenceURI;

  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(uri);
  } catch (error) {
    const problem = error instanceof DocumentUnavailableError ? error.message : String(error);
    return { status: { uri, problem }, poisoned: false };
  }

  const integrity = checkIntegrity(bytes, receipt.evidenceHash);
  if (!integrity.ok) {
    return {
      status: { uri, problem: integrity.reason, byteLength: integrity.byteLength },
      integrityReason: integrity.reason,
      poisoned: true,
    };
  }

  const parsed = parseJsonDocument(EvidenceBundleViewSchema, integrity.document);
  if (!parsed.ok) {
    return {
      status: {
        uri,
        problem: `the document the receipt commits to is not a mandate.evidence-bundle/1: ${parsed.reason}`,
        encoding: integrity.encoding,
        byteLength: integrity.byteLength,
      },
      poisoned: false,
    };
  }

  return {
    status: { uri, encoding: integrity.encoding, byteLength: integrity.byteLength },
    bundle: parsed.value,
    poisoned: false,
  };
}

async function loadDisclosure(
  activation: OnChainActivation,
): Promise<{ status: DocumentStatus; value?: MandateDisclosureView }> {
  const uri = activation.disclosureURI;
  if (uri.length === 0) {
    return {
      status: {
        uri: "",
        problem:
          "the activation record stores no URI for the granted authority document, so there is nothing to check against its on-chain hash",
      },
    };
  }

  const result = await fetchJsonDocument(uri, MandateDisclosureViewSchema);
  if (!result.ok) return { status: { uri, problem: result.reason } };
  return { status: { uri }, value: result.value };
}

/**
 * The run record, fetched from the directory the chain-committed evidence URI
 * points at.
 *
 * Derived from that URI rather than configured, so it follows the chain rather
 * than a build-time constant — but nothing on chain commits to a hash for it,
 * and the page says so wherever a value sourced from it is shown.
 */
async function loadRunRecord(
  evidenceUri: string,
): Promise<{ status: DocumentStatus; value?: ProofManifestView }> {
  let uri: string;
  try {
    uri = new URL("proof-manifest.json", evidenceUri).href;
  } catch {
    return {
      status: {
        uri: evidenceUri,
        problem: "the evidence URI is not a base a sibling run record could be resolved against",
      },
    };
  }

  const result = await fetchJsonDocument(uri, ProofManifestViewSchema);
  if (!result.ok) return { status: { uri, problem: result.reason } };
  return { status: { uri }, value: result.value };
}

function buildNotes(
  evidence: EvidenceState,
  disclosure: { status: DocumentStatus },
  runRecord: { status: DocumentStatus; value?: ProofManifestView },
): string[] {
  const notes: string[] = [
    "Only the hashes are trusted. The URIs below are hints about where a copy of each document might be found; any host serving bytes that hash to the on-chain commitment is as good as any other.",
  ];

  if (evidence.status.encoding === "RECANONICALISED") {
    notes.push(
      "The evidence document did not arrive as the canonical byte string. It re-encodes under MCJ/1 to the hash the receipt commits to, which is a sound check but a weaker property than byte-identical.",
    );
  }
  if (disclosure.status.problem !== undefined) notes.push(disclosure.status.problem);
  if (runRecord.status.problem !== undefined) {
    notes.push(`The run record was not read: ${runRecord.status.problem}`);
  }
  if (runRecord.value !== undefined) {
    notes.push(
      "The run record is the operator's own log of the run. Nothing on chain commits to a hash for it, so every value taken from it is labelled as such.",
    );
  }

  return notes;
}

// --- trial steps -----------------------------------------------------------

function stepTrialReceipt(
  receiptId: Hex,
  receipt: OnChainReceipt,
  bundle: EvidenceBundleView | undefined,
): Step {
  const recomputed = recomputeReceiptId(receipt, CHAIN_ID);
  const detail: Record<string, string> = {
    "receipt id": receiptId,
    publisher: receipt.publisher,
    "trial result": receipt.passed ? "PASS" : "FAIL",
  };

  if (recomputed.toLowerCase() !== receiptId.toLowerCase()) {
    return fail("trial receipt", "the stored fields do not reproduce the receipt id", {
      ...detail,
      recomputed,
    });
  }

  if (bundle !== undefined) {
    const specHash = canonicalHash(bundle.trialSpec as unknown as CanonicalValue);
    if (specHash.toLowerCase() !== receipt.trialSpecHash.toLowerCase()) {
      return fail("trial receipt", "the disclosed TrialSpec does not hash to the receipt's trialSpecHash", {
        "on chain": receipt.trialSpecHash,
        disclosed: specHash,
      });
    }
  }

  return pass("trial receipt", "published in the registry and its id recomputes from its own fields", detail);
}

function stepAgentIdentity(
  receipt: OnChainReceipt,
  bundle: EvidenceBundleView | undefined,
  probe: { exists: boolean; owner?: Address } | undefined,
): Step {
  const detail: Record<string, string> = {
    "identity registry": receipt.identityRegistry,
    "agent id": receipt.agentId.toString(10),
  };

  if (probe !== undefined && !probe.exists) {
    return fail(
      "agent identity",
      `agent ${receipt.agentId} is not registered at ${receipt.identityRegistry}`,
      detail,
    );
  }
  if (probe?.owner !== undefined) detail["registered to"] = probe.owner;

  if (bundle !== undefined) {
    const spec = bundle.trialSpec.agent;
    if (
      spec.identityRegistry.toLowerCase() !== receipt.identityRegistry.toLowerCase() ||
      spec.agentId !== receipt.agentId.toString(10)
    ) {
      return fail("agent identity", "the disclosed TrialSpec names a different agent than the receipt", {
        ...detail,
        "spec registry": spec.identityRegistry,
        "spec agent id": spec.agentId,
      });
    }

    const subject = bundle.testedAuthority.subject.agentIdentity;
    if (
      subject.identityRegistry.toLowerCase() !== receipt.identityRegistry.toLowerCase() ||
      subject.agentId !== receipt.agentId.toString(10)
    ) {
      return fail(
        "agent identity",
        "the tested authority was written for a different agent than the receipt names",
        detail,
      );
    }
  }

  if (probe === undefined && bundle === undefined) {
    return skip(
      "agent identity",
      `nothing to check the receipt's agent against: no contract at ${receipt.identityRegistry} on this chain, and no TrialSpec was disclosed`,
    );
  }

  const how =
    probe === undefined
      ? "matches the disclosed TrialSpec and tested authority; the identity registry has no code on this chain, so on-chain existence was not probed"
      : bundle === undefined
        ? "the agent exists on the identity registry the receipt names"
        : "the agent exists on chain and matches the disclosed TrialSpec and tested authority";

  return pass("agent identity", how, detail);
}

function stepAgentVersion(receipt: OnChainReceipt, bundle: EvidenceBundleView | undefined): Step {
  if (bundle === undefined) {
    return skip(
      "agent version",
      `the receipt commits to agent version ${receipt.agentVersionHash}, but no TrialSpec was disclosed to check it against`,
    );
  }

  if (bundle.trialSpec.agent.agentVersionHash.toLowerCase() !== receipt.agentVersionHash.toLowerCase()) {
    return fail("agent version", "the disclosed TrialSpec certifies a different agent build", {
      "on chain": receipt.agentVersionHash,
      "in spec": bundle.trialSpec.agent.agentVersionHash,
    });
  }

  if (
    bundle.testedAuthority.subject.agentVersionHash.toLowerCase() !== receipt.agentVersionHash.toLowerCase()
  ) {
    return fail("agent version", "the tested authority was written for a different agent build", {
      "on chain": receipt.agentVersionHash,
      "in tested authority": bundle.testedAuthority.subject.agentVersionHash,
    });
  }

  return pass("agent version", "the trial spec and tested authority name the build the receipt certifies", {
    "agent version": receipt.agentVersionHash,
  });
}

function stepEvidenceHash(receipt: OnChainReceipt, evidence: EvidenceState): Step {
  if (evidence.integrityReason !== undefined) {
    return fail("evidence hash", evidence.integrityReason, { "on chain": receipt.evidenceHash });
  }
  if (evidence.status.problem !== undefined && evidence.status.encoding === undefined) {
    return skip("evidence hash", evidence.status.problem);
  }
  if (evidence.status.encoding === undefined) {
    return skip("evidence hash", "the evidence document was not retrieved");
  }

  return pass("evidence hash", "the fetched document is what the receipt committed to", {
    hash: receipt.evidenceHash,
    encoding: evidence.status.encoding,
    bytes: String(evidence.status.byteLength ?? 0),
  });
}

/**
 * What the page can and cannot say about the reference model.
 *
 * The cross-checks below are real and can fail: the block the run forked at,
 * the scenario, the evaluator and the reference model the receipt commits to,
 * and the result the artifact states against the result the chain published.
 * The replay itself is a different matter. `referenceModelHash` is a hash of
 * the model's own source, so reproducing the answer means executing that
 * source, which a page has no access to. Reporting that as PASS would claim an
 * independent recomputation that did not happen.
 */
function stepReferenceResult(receipt: OnChainReceipt, bundle: EvidenceBundleView | undefined): Step {
  if (bundle === undefined) {
    return skip("reference result", "no evidence artifact was available to check");
  }

  const artifact = bundle.artifact;
  if (artifact.environment.forkBlock !== receipt.snapshotBlock.toString(10)) {
    return fail("reference result", "the run was executed at a different block than the receipt pins", {
      "receipt snapshotBlock": receipt.snapshotBlock.toString(10),
      "artifact forkBlock": artifact.environment.forkBlock,
    });
  }

  const spec = bundle.trialSpec;
  const committed: Array<[string, Hex, Hex]> = [
    ["scenario", receipt.scenarioHash, spec.scenario.scenarioHash],
    ["evaluator", receipt.evaluatorHash, spec.evaluator.codeHash],
    ["reference model", receipt.referenceModelHash, spec.evaluator.referenceModelHash],
  ];
  for (const [label, onChain, disclosed] of committed) {
    if (onChain.toLowerCase() !== disclosed.toLowerCase()) {
      return fail("reference result", `the disclosed ${label} is not the one the receipt commits to`, {
        "on chain": onChain,
        disclosed,
      });
    }
  }

  const stated = artifactResult(artifact);
  const onChainResult = receipt.passed ? "PASS" : "FAIL";
  if (stated !== undefined && stated !== onChainResult) {
    return fail("reference result", "the artifact's result contradicts the receipt published on chain", {
      "on chain": onChainResult,
      "in artifact": stated,
    });
  }

  const checks = artifactCheckCount(artifact);
  return skip(
    "reference result",
    `the artifact pins the block, the scenario, the evaluator and the reference model the receipt commits to, and states ${stated ?? "no result"}, which agrees with the chain. The replay itself was not reproduced here: referenceModelHash ${receipt.referenceModelHash} is a hash of the model's own source, and re-executing that source needs the repository. Run pnpm verify:mandate to reproduce it${checks === undefined ? "" : ` against the artifact's ${checks} recorded check(s)`}.`,
  );
}

function stepTestedAuthority(
  receipt: OnChainReceipt,
  bundle: EvidenceBundleView | undefined,
  poisoned: boolean,
): Step {
  if (poisoned) {
    return skip("tested authority", "the evidence failed its hash check, so nothing in it was read");
  }
  if (bundle === undefined) {
    return skip(
      "tested authority",
      `the receipt commits to tested authority ${receipt.testedAuthorityHash}, but the evidence document discloses no AuthorityIR to check it against`,
    );
  }

  const hash = authorityHash(bundle.testedAuthority);
  if (hash.toLowerCase() !== receipt.testedAuthorityHash.toLowerCase()) {
    return fail("tested authority", "the disclosed AuthorityIR does not hash to the receipt's commitment", {
      "on chain": receipt.testedAuthorityHash,
      disclosed: hash,
    });
  }

  const specAuthority = authorityHash(bundle.trialSpec.authority);
  if (specAuthority.toLowerCase() !== hash.toLowerCase()) {
    return fail(
      "tested authority",
      "the authority embedded in the TrialSpec differs from the tested authority the receipt commits to",
      { "trial spec": specAuthority, "tested authority": hash },
    );
  }

  return pass("tested authority", "the disclosed envelope hashes to the receipt's commitment", {
    hash,
    calls: String(bundle.testedAuthority.calls.length),
    spend: String(bundle.testedAuthority.spend.length),
    "max lifetime": `${bundle.testedAuthority.lifetime.maxDurationSeconds}s`,
  });
}

// --- mandate steps ---------------------------------------------------------

function recoverSequence(mandateId: Hex, activation: OnChainActivation): number | undefined {
  for (let sequence = 0; sequence < MAX_SEQUENCE_SCAN; sequence += 1) {
    const candidate = deriveMandateId({
      chainId: CHAIN_ID,
      wallet: activation.wallet,
      trialReceiptId: activation.trialReceiptId,
      grantedAuthorityHash: activation.grantedAuthorityHash,
      sequence,
    });
    if (candidate.toLowerCase() === mandateId.toLowerCase()) return sequence;
  }
  return undefined;
}

function stepGrantedAuthority(
  mandateId: Hex,
  activation: OnChainActivation,
  sequence: number | undefined,
  granted: AuthorityIR | undefined,
  problem: string | undefined,
): Step {
  if (sequence === undefined) {
    return fail(
      "granted authority",
      `the activation's fields do not reproduce the mandate id at any renewal sequence below ${MAX_SEQUENCE_SCAN}`,
      { "mandate id": mandateId, "granted authority": activation.grantedAuthorityHash },
    );
  }

  if (granted === undefined) {
    return skip(
      "granted authority",
      problem ??
        `the chain commits to granted authority ${activation.grantedAuthorityHash} but no document was retrieved to check against it`,
    );
  }

  const hash = authorityHash(granted);
  if (hash.toLowerCase() !== activation.grantedAuthorityHash.toLowerCase()) {
    return fail("granted authority", "the disclosed AuthorityIR is not the one the mandate was activated with", {
      "on chain": activation.grantedAuthorityHash,
      disclosed: hash,
    });
  }

  return pass(
    "granted authority",
    "the disclosed grant hashes to the activation's commitment, and the activation reproduces the mandate id",
    {
      hash,
      "renewal sequence": String(sequence),
      wallet: activation.wallet,
      calls: String(granted.calls.length),
    },
  );
}

function stepSubsetRelation(
  bundle: EvidenceBundleView | undefined,
  granted: AuthorityIR | undefined,
  grantAuthenticated: boolean,
  result: SubsetResult | undefined,
): Step {
  if (bundle === undefined) {
    return skip("subset relation", "the tested AuthorityIR was not disclosed, so nothing can be compared");
  }
  if (granted === undefined) {
    return skip("subset relation", "the granted AuthorityIR was not disclosed, so nothing can be compared");
  }
  if (!grantAuthenticated || result === undefined) {
    // Same rule as a bad evidence hash: a document the chain disowned is not
    // evidence of anything, and a verdict computed from it would look like a
    // finding about the mandate when it is only a finding about the file.
    return skip(
      "subset relation",
      "the disclosed grant does not hash to the activation's commitment, so it was not used for anything",
    );
  }

  if (!result.subset) {
    return fail(
      "subset relation",
      `the granted authority is NOT within the tested authority: ${result.violations
        .map((violation) => `${violation.rule} at ${violation.path} (${violation.message})`)
        .join("; ")}`,
      { comparator: `${result.comparatorVersion} / ${result.comparatorHash}` },
    );
  }

  return pass("subset relation", "recomputed from both disclosed documents: granted ⊆ tested", {
    comparator: `${result.comparatorVersion} / ${result.comparatorHash}`,
    rules: "re-run on this page, not read from the artifact's proof block",
  });
}

/**
 * Was this session actually granted, and what became of it?
 *
 * The activation states the window the grant covered and, once revoked, the
 * moment it ended. A revoked session leaves an account holding no key, and an
 * empty account is the same observation for "revoked since activation" and
 * "never granted at all" — so the window is what turns a finished mandate from
 * an unanswerable question into a reconstruction from the record.
 *
 * The record never overrules the account. A registry that says revoked while
 * the account still holds a live key, or says live while the account holds
 * nothing inside the window, is a contradiction and is printed as one.
 */
async function stepSessionRegistration(
  client: PublicClient,
  activation: OnChainActivation,
  disclosure: MandateDisclosureView | undefined,
  now: number,
): Promise<Step> {
  const disclosed = disclosure?.session;
  if (disclosed !== undefined) {
    if (disclosed.keyHash.toLowerCase() !== activation.sessionKeyHash.toLowerCase()) {
      return fail("session registration", "the disclosure names a different session key than the activation", {
        "on chain": activation.sessionKeyHash,
        disclosed: disclosed.keyHash,
      });
    }
    if (disclosed.wallet.toLowerCase() !== activation.wallet.toLowerCase()) {
      return fail("session registration", "the disclosure names a different wallet than the activation", {
        "on chain": activation.wallet,
        disclosed: disclosed.wallet,
      });
    }
  }

  const validUntil = Number(activation.validUntil);
  const revokedAt = Number(activation.revokedAt);
  const grant = {
    wallet: activation.wallet,
    "key hash": activation.sessionKeyHash,
    "granted from": utcSeconds(Number(activation.validFrom)),
    "valid until": utcSeconds(validUntil),
  };

  const account = await readAccountAuthority(client, activation);

  if (revokedAt !== 0) {
    if (account.enforced?.registered === true) {
      return fail(
        "session registration",
        `the registry records this mandate revoked at ${utcSeconds(revokedAt)}, but the account still holds a key with this hash`,
        {
          ...grant,
          "revoked at": utcSeconds(revokedAt),
          "read at block": account.enforced.observedAtBlock.toString(10),
        },
      );
    }

    return pass(
      "session registration",
      "the session was granted over the window the activation records and revoked through the registry, both reconstructed from chain",
      {
        ...grant,
        "revoked at": utcSeconds(revokedAt),
        "attested by": activation.attestedBy,
        account:
          account.enforced === undefined
            ? account.reason
            : `holds no key with this hash at block ${account.enforced.observedAtBlock}, which is what a revoked mandate looks like`,
      },
    );
  }

  if (account.enforced === undefined) {
    return skip("session registration", account.reason);
  }
  const enforced = account.enforced;

  if (!enforced.registered) {
    if (now > validUntil) {
      // The window closing on its own is the record's own prediction coming
      // true. Reporting it as a gap would make every finished mandate look
      // broken.
      return pass(
        "session registration",
        "the session's window closed and no revocation was recorded, and the account holds no key, which is what the record predicts",
        { ...grant, "revoked at": "never recorded", "read at block": enforced.observedAtBlock.toString(10) },
      );
    }

    return fail(
      "session registration",
      `the registry records no revocation and the window runs to ${utcSeconds(validUntil)}, but the account holds no key with hash ${activation.sessionKeyHash} at block ${enforced.observedAtBlock}`,
      { ...grant, "read at block": enforced.observedAtBlock.toString(10) },
    );
  }

  if (enforced.isSuperAdmin) {
    return fail(
      "session registration",
      "the session key is registered as a super-admin, so it is not bounded by any permission set",
      grant,
    );
  }

  const wildcards = [...enforced.callRules, ...enforced.walletWideRules].filter(
    (rule) => rule.targetIsWildcard,
  );
  if (wildcards.length > 0) {
    return fail(
      "session registration",
      `the account enforces ${wildcards.length} rule(s) with a wildcard target, so the session can reach every contract`,
      grant,
    );
  }

  if (enforced.expiry !== validUntil) {
    // The activation is a public claim about how long the authority lasts. A
    // reader planning around a published window the account does not enforce is
    // planning around a number nothing backs.
    return fail(
      "session registration",
      "the account expires this key at a different time than the activation committed to",
      { ...grant, "account expiry": utcSeconds(enforced.expiry), "read at block": enforced.observedAtBlock.toString(10) },
    );
  }

  return pass("session registration", "the account itself holds this key, with a bounded permission set", {
    ...grant,
    "call rules": `${enforced.callRules.length} on this key, ${enforced.walletWideRules.length} wallet-wide`,
    "spend limits": String(enforced.spendLimits.length),
    "read at block": enforced.observedAtBlock.toString(10),
  });
}

/** Unix seconds as UTC, or the word for the absence of a time. */
function utcSeconds(unixSeconds: number): string {
  return unixSeconds === 0 ? "none" : new Date(unixSeconds * 1000).toISOString();
}

/**
 * The account's own view of the session key, or why there is none.
 *
 * Separated from the step so "the account contradicts the record" and "the
 * account could not be asked" stay distinguishable. Collapsing them would let
 * an unreachable endpoint read as agreement.
 */
async function readAccountAuthority(
  client: PublicClient,
  activation: OnChainActivation,
): Promise<{ enforced?: Awaited<ReturnType<typeof readEnforcedAuthority>>; reason: string }> {
  const code = await client.getCode({ address: activation.wallet }).catch(() => undefined);
  if (code === undefined || code === "0x") {
    return {
      reason: `${activation.wallet} carries no account code on this chain, so its permission storage cannot be read`,
    };
  }

  try {
    return {
      enforced: await readEnforcedAuthority(client, {
        wallet: activation.wallet,
        keyHash: activation.sessionKeyHash,
      }),
      reason: "read",
    };
  } catch (error) {
    return {
      reason: `the account at ${activation.wallet} did not answer the permission reads: ${describe(error)}`,
    };
  }
}

function stepAllowedExecution(findings: readonly ExecutedEvidence[], disclosed: boolean): Step {
  const permitted = findings.filter((finding) => finding.outcome !== "REVERTED");
  if (permitted.length === 0) {
    return skip(
      "allowed execution",
      disclosed
        ? "the disclosure lists no permitted execution"
        : "no disclosure was supplied, so no execution transactions were named",
    );
  }

  const bad = permitted.filter((finding) => finding.outcome !== "CONFIRMED");
  if (bad.length > 0) {
    return skip(
      "allowed execution",
      bad
        .map((finding) => `${finding.label} (${finding.txHash}): ${finding.outcomeReason ?? "not re-read"}`)
        .join("; "),
    );
  }

  return pass(
    "allowed execution",
    `${permitted.length} transaction(s) confirmed on chain inside the granted authority`,
    Object.fromEntries(permitted.map((finding) => [finding.label, finding.txHash])),
  );
}

/**
 * Reverted transactions, which this mandate has none of.
 *
 * Kept as its own step rather than folded into rejected intents, because the
 * two are different guarantees and a shared step would let one stand in for the
 * other. A SKIP here is the correct and expected result: the account refuses an
 * out-of-scope intent before broadcast, so there is normally nothing to revert.
 */
function stepBlockedExecution(disclosure: MandateDisclosureView | undefined): Step {
  const blocked = disclosure?.blockedExecutions ?? [];
  if (blocked.length === 0) {
    return skip(
      "blocked execution",
      disclosure === undefined
        ? "no disclosure was supplied, so no execution transactions were named"
        : "the disclosure lists no boundary-crossing execution that produced a transaction. Refusals happened before broadcast and are reported under rejected intents.",
    );
  }

  return skip(
    "blocked execution",
    `${blocked.length} reverted transaction(s) are named, and this page does not re-read reverted calldata. Run pnpm verify:mandate to attribute them.`,
  );
}

/**
 * The step that exists because a rejection is not a revert.
 *
 * There is no hash to fetch, so this cannot confirm a refusal the way the
 * executed step confirms a transaction. What it can do is refuse to take the
 * publisher's conclusion on trust: the recorded account state must actually
 * IMPLY the mechanism claimed. A record asserting "the spend cap stopped it"
 * while recording a cap the attempt fits inside is self-contradictory, and this
 * is where that shows up.
 *
 * The allowance check is the one that matters most. An exhausted ERC-20
 * allowance stops the same call and looks identical from the outside, so a
 * spend-cap claim is only credible if the allowance at the attempt covered the
 * amount. Without that figure the claim is unverifiable.
 *
 * These are the checks and the wording `apps/verifier/src/steps-rejected.ts`
 * applies, so a reader who runs the CLI after reading this page sees the same
 * sentences rather than two descriptions of one fact.
 */
function stepRejectedIntents(
  rejected: readonly RejectedIntentEvidence[],
  malformed: readonly MalformedEvidence[],
  disclosed: boolean,
): Step {
  if (malformed.length > 0) {
    return fail("rejected intents", malformed.map((item) => `${item.label}: ${item.reason}`).join("; "));
  }
  if (!disclosed && rejected.length === 0) {
    return skip("rejected intents", "no disclosure was supplied, so no refused intents were named");
  }
  if (rejected.length === 0) {
    return skip("rejected intents", "the disclosure records no refused intent");
  }

  const problems = rejected
    .map(corroborationProblem)
    .filter((problem): problem is string => problem !== undefined);
  if (problems.length > 0) return fail("rejected intents", problems.join("; "));

  return pass(
    "rejected intents",
    `${rejected.length} intent(s) refused by the account before broadcast, each corroborated by the account's own state at the attempt. No transaction exists for any of them, so there is nothing on an explorer to open — the boundary held earlier than a revert.`,
    Object.fromEntries(rejected.map((item) => [item.label, item.validatorError])),
  );
}

/** Does the recorded state actually imply the mechanism the record claims? */
function corroborationProblem(intent: RejectedIntentEvidence): string | undefined {
  const state = intent.accountState;

  if (intent.mechanism === "SPEND_CAP") {
    if (state.callPermitted === false) {
      return `${intent.label}: claims the spend cap refused it, but the account also says the call itself was not permitted, which would refuse it first`;
    }
    if (
      state.spendCapRaw === undefined ||
      state.spentInBucketRaw === undefined ||
      intent.amountRaw === undefined
    ) {
      return `${intent.label}: claims the spend cap refused it but does not record the cap, the amount already spent and the amount attempted`;
    }
    if (BigInt(state.spentInBucketRaw) + BigInt(intent.amountRaw) <= BigInt(state.spendCapRaw)) {
      return `${intent.label}: claims the spend cap refused it, but ${state.spentInBucketRaw} + ${intent.amountRaw} is within the ${state.spendCapRaw} cap`;
    }
    if (state.allowanceAtAttemptRaw === undefined) {
      return `${intent.label}: claims the spend cap refused it but does not record the token allowance, so an exhausted allowance cannot be ruled out`;
    }
    if (BigInt(state.allowanceAtAttemptRaw) < BigInt(intent.amountRaw)) {
      return `${intent.label}: the allowance of ${state.allowanceAtAttemptRaw} was below the ${intent.amountRaw} attempted, so the allowance and not the spend cap was the binding constraint`;
    }
    if (intent.validatorError !== "ExceededSpendLimit" && intent.validatorError !== "NoSpendPermissions") {
      return `${intent.label}: claims the spend cap refused it but records ${intent.validatorError}`;
    }
    return undefined;
  }

  if (intent.mechanism === "OUT_OF_SCOPE_CALL") {
    if (state.callPermitted === true) {
      return `${intent.label}: claims the call was out of scope, but the account says it was permitted`;
    }
    if (intent.validatorError !== "UnauthorizedCall" && intent.validatorError !== "CannotSelfExecute") {
      return `${intent.label}: claims the call was out of scope but records ${intent.validatorError}`;
    }
    return undefined;
  }

  if (state.keyRegistered === true) {
    return `${intent.label}: claims the session was invalid, but the account still held the key`;
  }
  return undefined;
}

// --- evidence collection ---------------------------------------------------

/**
 * Map a run-record step onto the mechanism it demonstrates.
 *
 * Explicit rather than inferred from the label, because a label is prose and
 * this decides which sentence the page prints about a security boundary.
 */
const STEP_MECHANISM: Record<string, RejectionMechanism> = {
  "cap-breach-attempt": "SPEND_CAP",
  "wrong-target-attempt": "OUT_OF_SCOPE_CALL",
  "post-revoke-execution-fails": "SESSION_INVALID",
};

const STEP_VALIDATOR_ERROR: Record<string, string> = {
  "cap-breach-attempt": "ExceededSpendLimit",
  "wrong-target-attempt": "UnauthorizedCall",
  "post-revoke-execution-fails": "KeyDoesNotExist",
};

function collectEvidence(
  disclosure: MandateDisclosureView | undefined,
  manifest: ProofManifestView | undefined,
): { executed: ExecutedEvidence[]; rejected: RejectedIntentEvidence[]; malformed: MalformedEvidence[] } {
  const items: (ProofEvidence | MalformedEvidence)[] = [];

  for (const entry of disclosure?.allowedExecutions ?? []) {
    items.push({
      kind: "EXECUTED",
      label: entry.label,
      txHash: entry.txHash as Hex,
      outcome: "UNVERIFIED",
      provenance: "DISCLOSURE",
    });
  }
  for (const entry of disclosure?.blockedExecutions ?? []) {
    items.push({
      kind: "EXECUTED",
      label: entry.label,
      txHash: entry.txHash as Hex,
      outcome: "UNVERIFIED",
      provenance: "DISCLOSURE",
    });
  }

  // A disclosure that carries its own rejected intents is preferred: it sits
  // beside the grant the chain committed to, and it does not need the step
  // names of one particular runner to be interpreted.
  const disclosedRejections = disclosure?.rejectedIntents ?? [];
  for (const entry of disclosedRejections) {
    items.push({
      kind: "REJECTED_INTENT",
      label: entry.label,
      target: entry.target.toLowerCase() as Address,
      selector: entry.selector,
      ...(entry.amountRaw === undefined ? {} : { amountRaw: entry.amountRaw }),
      validatorError: entry.validatorError,
      mechanism: entry.mechanism,
      accountState: entry.accountState as RejectedIntentAccountState,
      provenance: "DISCLOSURE",
    });
  }

  if (manifest !== undefined) {
    const context = rejectionContextFrom(manifest);
    const knownTx = new Set(
      items.filter((item): item is ExecutedEvidence => item.kind === "EXECUTED").map((item) => item.txHash.toLowerCase()),
    );

    for (const record of manifest.executions) {
      // Anything the disclosure already named keeps the disclosure's provenance.
      if (record.txHash !== undefined && knownTx.has(record.txHash.toLowerCase())) continue;
      if (disclosedRejections.length > 0 && record.txHash === undefined) continue;

      items.push(
        classifyExecutionRecord(
          {
            step: record.step,
            label: record.label,
            status: record.status,
            target: record.target,
            selector: record.selector,
            amountRaw: record.amountRaw,
            txHash: record.txHash,
          },
          context,
        ),
      );
    }
  }

  return partitionEvidence(items);
}

function rejectionContextFrom(manifest: ProofManifestView): RejectionContext {
  const accountStateByStep: Record<string, RejectedIntentAccountState> = {};

  for (const step of manifest.steps) {
    const evidence = Object.fromEntries((step.evidence ?? []).map((entry) => [entry.label, entry.value]));

    if (step.id === "cap-breach-attempt") {
      accountStateByStep["cap-breach-attempt"] = {
        ...(evidence["capRaw"] === undefined ? {} : { spendCapRaw: evidence["capRaw"] }),
        ...(evidence["spentInBucketRaw"] === undefined
          ? {}
          : { spentInBucketRaw: evidence["spentInBucketRaw"] }),
        ...(evidence["allowanceAtAttemptRaw"] === undefined
          ? {}
          : { allowanceAtAttemptRaw: evidence["allowanceAtAttemptRaw"] }),
        keyRegistered: true,
        callPermitted: true,
      };
    }

    if (step.id === "wrong-target-rejected") {
      accountStateByStep["wrong-target-attempt"] = { callPermitted: false, keyRegistered: true };
    }

    if (step.id === "post-revoke-execution-fails") {
      accountStateByStep["post-revoke-execution-fails"] = {
        keyRegistered: evidence["accountHoldsKey"] === "true",
      };
    }
  }

  return {
    validatorErrorByStep: STEP_VALIDATOR_ERROR,
    mechanismByStep: STEP_MECHANISM,
    accountStateByStep,
  };
}

/**
 * Re-read a named transaction from chain.
 *
 * The disclosure says a transaction demonstrates something. Believing that
 * without fetching it would make the page a reprint of the publisher's claim.
 *
 * Attribution is by the contracts the transaction touched, not by its sender. A
 * session key submits through a relay, so the sender is the relay's address and
 * checking it against the wallet would flag every correctly relayed execution.
 * What actually ties a transaction to the mandate is an event from a contract
 * inside the granted authority, which is what is checked here.
 */
async function confirmExecution(
  client: PublicClient,
  grantedTargets: ReadonlySet<string>,
  evidence: ExecutedEvidence,
): Promise<ExecutedEvidence> {
  try {
    const receipt = await client.getTransactionReceipt({ hash: evidence.txHash });
    const touched = receipt.logs.some((log) => grantedTargets.has(log.address.toLowerCase()));
    return {
      ...evidence,
      outcome: receipt.status === "success" ? "CONFIRMED" : "REVERTED",
      ...(receipt.to === null ? {} : { submittedTo: receipt.to.toLowerCase() as Address }),
      ...(grantedTargets.size === 0 ? {} : { touchedGrantedTarget: touched }),
      ...(grantedTargets.size > 0 && !touched
        ? {
            outcomeReason:
              "the transaction confirmed, but it emitted no event from a contract inside the granted authority, so this page cannot attribute it to the mandate",
          }
        : {}),
    };
  } catch (error) {
    return {
      ...evidence,
      outcome: "UNVERIFIED",
      outcomeReason: `the endpoint did not return a receipt for this transaction: ${describe(error)}`,
    };
  }
}

// --- misc ------------------------------------------------------------------

async function probeIdentity(
  client: PublicClient,
  receipt: OnChainReceipt,
): Promise<{ exists: boolean; owner?: Address } | undefined> {
  const code = await client.getCode({ address: receipt.identityRegistry }).catch(() => undefined);
  if (code === undefined || code === "0x") return undefined;

  try {
    const owner = await client.readContract({
      address: receipt.identityRegistry,
      abi: ERC721_ABI,
      functionName: "ownerOf",
      args: [receipt.agentId],
    });
    return { exists: true, owner: owner.toLowerCase() as Address };
  } catch {
    return { exists: false };
  }
}

function spendWindowOf(manifest: ProofManifestView | undefined): SpendWindow | undefined {
  const bucket = manifest?.spendBucket;
  if (bucket === undefined) return undefined;
  return {
    period: bucket.period,
    bucketStart: Number(bucket.bucketStart),
    bucketEnd: Number(bucket.bucketEnd),
    calendarAligned: bucket.semanticsMatchUtcMidnight === true,
  };
}

function summariseReceipt(receiptId: Hex, receipt: OnChainReceipt): ReceiptSummary {
  return {
    receiptId,
    publisher: receipt.publisher,
    identityRegistry: receipt.identityRegistry,
    agentId: receipt.agentId.toString(10),
    agentVersionHash: receipt.agentVersionHash,
    evidenceURI: receipt.evidenceURI,
    evidenceHash: receipt.evidenceHash,
    testedAuthorityHash: receipt.testedAuthorityHash,
    passed: receipt.passed,
    createdAt: Number(receipt.createdAt),
    freshUntil: Number(receipt.freshUntil),
    publishedAt: Number(receipt.publishedAt),
    snapshotBlock: receipt.snapshotBlock.toString(10),
  };
}

function summariseMandate(
  mandateId: Hex,
  activation: OnChainActivation,
  sequence: number | undefined,
): MandateSummary {
  return {
    mandateId,
    label: mandateLabel(mandateId),
    wallet: activation.wallet,
    sessionKeyHash: activation.sessionKeyHash,
    grantedAuthorityHash: activation.grantedAuthorityHash,
    attestedBy: activation.attestedBy,
    activatedAt: Number(activation.activatedAt),
    validFrom: Number(activation.validFrom),
    validUntil: Number(activation.validUntil),
    revokedAt: Number(activation.revokedAt),
    disclosureURI: activation.disclosureURI,
    ...(sequence === undefined ? {} : { sequence }),
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.name;
  return String(error);
}

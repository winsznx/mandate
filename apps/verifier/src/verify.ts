/**
 * The verification path, start to finish.
 *
 * The rule this file exists to honour: a judge with a chain RPC and this
 * repository must be able to reach a verdict. There is no Supabase client here,
 * no MANDATE API base URL, no indexer. The chain is read for commitments, the
 * evidence URI is dereferenced for the documents those commitments name, and
 * everything else is recomputed locally.
 *
 * The activation is read as a lifecycle rather than as a snapshot. It carries
 * the URI the granted AuthorityIR is fetched from, the window the session was
 * valid over, and the moment it was revoked, so a mandate that has already
 * finished is still checkable: the grant is reconstructed from what the
 * registry committed to, and the account is consulted to corroborate that
 * reconstruction rather than to supply it. Nothing about that relaxes the hash
 * rule — a document is believed only once it hashes to the commitment the
 * activation carries, and one that does not is repudiated.
 */
import { authorityHash, isSubset } from "@mandate/authority-ir";
import { readEnforcedAuthority } from "@mandate/altana";
import { canonicalHash } from "@mandate/domain/canonical";
import type { CanonicalValue } from "@mandate/domain/canonical";
import { deriveMandateId } from "@mandate/domain";
import type { Address, Hex, PublicClient } from "viem";
import { parseEvidenceDocument, parseMandateDisclosure } from "./bundle.js";
import type { EvidenceBundle, MandateDisclosure } from "./bundle.js";
import type { ResolvedTarget } from "./config.js";
import { checkEvidenceIntegrity } from "./evidence.js";
import type { EvidenceIntegrityResult } from "./evidence.js";
import { checkAllowedExecution, checkBlockedExecution } from "./execution.js";
import type { ExecutionContext, ExecutionFinding } from "./execution.js";
import {
  readActivation,
  readReceipt,
  recomputeReceiptId,
  UnknownMandateError,
  UnknownReceiptError,
} from "./registry.js";
import type { OnChainActivation, OnChainReceipt } from "./registry.js";
import { replayEvaluation } from "./replay.js";
import { replayRichEvidence } from "./replay-rich.js";
import { healthFactorModelRunner } from "./reference-binding.js";
import type { ReplayResult } from "./replay.js";
import { decideVerdict, fail, orderSteps, pass, skip } from "./steps.js";
import { stepRejectedIntents } from "./steps-rejected.js";
import type { Step, Verdict } from "./steps.js";
import { EvidenceUnavailableError, fetchEvidenceBytes } from "./uri.js";
import type { FetchOptions } from "./uri.js";
import type { AuthorityIR, EvidenceArtifact, TrialEvidence } from "./types.js";
import {
  artifactChecks,
  isFlatArtifact,
  artifactModificationLabel,
  artifactReferenceModelId,
  artifactReferenceModelVersion,
  artifactResult,
  artifactStateModified,
  artifactTrialSpecHash,
} from "./artifact-view.js";

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
 * The `Activation` record does not store the sequence, so it has to be found by
 * trial. A bounded scan keeps a failure meaningful: 256 renewals of one mandate
 * is far outside any real lifecycle, so exhausting the range means the record
 * genuinely does not reproduce its own id.
 */
const MAX_SEQUENCE_SCAN = 256;

export interface VerifyOptions {
  target: ResolvedTarget;
  client: PublicClient;
  /** Unix seconds. Injected rather than read from the clock so results are reproducible. */
  now: number;
  /** Location of the mandate disclosure document, when the caller has one. */
  disclosureUri?: string | undefined;
  fetch?: FetchOptions | undefined;
}

export interface ReceiptSummary {
  receiptId: Hex;
  publisher: Address;
  identityRegistry: Address;
  agentId: string;
  agentVersionHash: Hex;
  evidenceURI: string;
  passed: boolean;
  createdAt: number;
  freshUntil: number;
  publishedAt: number;
  snapshotBlock: string;
}

export interface MandateSummary {
  mandateId: Hex;
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
  /** Renewal sequence recovered by recomputing the id, when it could be recovered. */
  sequence?: number;
}

export interface VerificationReport {
  subject: { kind: "TRIAL" | "MANDATE"; id: Hex };
  network: { chainId: number; name: string; rpcUrl: string; registry: Address; registrySource: string };
  receipt?: ReceiptSummary;
  mandate?: MandateSummary;
  steps: Step[];
  verdict: Verdict;
  /** Things a reader needs to know that are not the outcome of a step. */
  notes: string[];
  executions: ExecutionFinding[];
}

/** Loaded evidence, or the reason there is none to work with. */
interface EvidenceState {
  integrity?: EvidenceIntegrityResult;
  /** Either the flat form or the richer `mandate.trial-evidence/1`, whichever was published. */
  artifact?: EvidenceArtifact | TrialEvidence;
  bundle?: EvidenceBundle;
  /** Set when the document could not be retrieved or read at all. */
  unavailable?: string;
  /** True once a hash mismatch has ruled the document out entirely. */
  poisoned: boolean;
}

/**
 * Replay whichever form was published.
 *
 * A rich artifact whose projection fails yields `undefined`, so the
 * reference-result step SKIPs with a stated reason rather than passing on a
 * comparison that never ran.
 */
function replayFor(artifact: EvidenceArtifact | TrialEvidence | undefined): ReplayResult | undefined {
  if (artifact === undefined) return undefined;
  if (isFlatArtifact(artifact)) return replayEvaluation(artifact);

  const outcome = replayRichEvidence({
    artifact,
    model: healthFactorModelRunner(artifact.reference.implementationHash),
  });
  return outcome.ok ? outcome.replay : undefined;
}

async function loadEvidence(receipt: OnChainReceipt, options: VerifyOptions): Promise<EvidenceState> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchEvidenceBytes(receipt.evidenceURI, options.fetch ?? {});
  } catch (error) {
    const reason =
      error instanceof EvidenceUnavailableError ? error.message : `evidence fetch failed: ${String(error)}`;
    return { unavailable: reason, poisoned: false };
  }

  const integrity = checkEvidenceIntegrity(bytes, receipt.evidenceHash);
  if (!integrity.ok) return { integrity, poisoned: true };

  const parsed = parseEvidenceDocument(integrity.document);
  if (!parsed.ok) {
    // The bytes are authentic; they just do not describe a trial in a shape
    // this verifier understands. That is a disclosure gap, not a forgery.
    return { integrity, unavailable: parsed.reason, poisoned: false };
  }

  return {
    integrity,
    artifact: parsed.value.artifact,
    ...(parsed.value.bundle === undefined ? {} : { bundle: parsed.value.bundle }),
    poisoned: false,
  };
}

/**
 * Resolve the mandate disclosure.
 *
 * The activation record carries a `disclosureURI`, so a judge with nothing but
 * a mandate id can obtain the granted AuthorityIR rather than having to be
 * handed one. `--disclosure` remains an override for reading a local copy or a
 * mirror, and either way the document is checked against the on-chain hash
 * before it is used, so resolving from chain grants it no extra trust.
 */
async function loadDisclosure(
  options: VerifyOptions,
  onChainUri?: string,
): Promise<{ disclosure?: MandateDisclosure; problem?: string }> {
  const uri = options.disclosureUri ?? (onChainUri === "" ? undefined : onChainUri);
  if (uri === undefined) return {};

  let bytes: Uint8Array;
  try {
    bytes = await fetchEvidenceBytes(uri, options.fetch ?? {});
  } catch (error) {
    return { problem: `mandate disclosure could not be read: ${String(error)}` };
  }

  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    return { problem: `mandate disclosure is not valid UTF-8 JSON: ${String(error)}` };
  }

  const parsed = parseMandateDisclosure(document);
  return parsed.ok ? { disclosure: parsed.value } : { problem: parsed.reason };
}

/**
 * Does the agent the receipt names exist on the identity registry it names?
 *
 * Returns `undefined` when the question cannot be asked — there is no ERC-8004
 * registry at that address on this chain — which is a different answer from
 * "no", and the caller keeps them apart.
 */
async function probeAgentExists(
  client: PublicClient,
  params: { registry: Address; agentId: bigint },
): Promise<{ exists: boolean; owner?: Address } | undefined> {
  const code = await client.getCode({ address: params.registry }).catch(() => undefined);
  if (code === undefined || code === "0x") return undefined;

  try {
    const owner = await client.readContract({
      address: params.registry,
      abi: ERC721_ABI,
      functionName: "ownerOf",
      args: [params.agentId],
    });
    return { exists: true, owner: owner.toLowerCase() as Address };
  } catch {
    // ERC-721 `ownerOf` reverts for a token that was never minted.
    return { exists: false };
  }
}

function summariseReceipt(receiptId: Hex, receipt: OnChainReceipt): ReceiptSummary {
  return {
    receiptId,
    publisher: receipt.publisher,
    identityRegistry: receipt.identityRegistry,
    agentId: receipt.agentId.toString(10),
    agentVersionHash: receipt.agentVersionHash,
    evidenceURI: receipt.evidenceURI,
    passed: receipt.passed,
    createdAt: Number(receipt.createdAt),
    freshUntil: Number(receipt.freshUntil),
    publishedAt: Number(receipt.publishedAt),
    snapshotBlock: receipt.snapshotBlock.toString(10),
  };
}

/** Recover the renewal sequence by finding the one that reproduces the mandate id. */
function recoverSequence(
  mandateId: Hex,
  activation: OnChainActivation,
  chainId: number,
): number | undefined {
  for (let sequence = 0; sequence < MAX_SEQUENCE_SCAN; sequence += 1) {
    const candidate = deriveMandateId({
      chainId,
      wallet: activation.wallet,
      trialReceiptId: activation.trialReceiptId,
      grantedAuthorityHash: activation.grantedAuthorityHash,
      sequence,
    });
    if (candidate.toLowerCase() === mandateId.toLowerCase()) return sequence;
  }
  return undefined;
}

// --- the steps ------------------------------------------------------------

function stepTrialReceipt(
  receiptId: Hex,
  receipt: OnChainReceipt,
  chainId: number,
  evidence: EvidenceState,
): Step {
  const recomputed = recomputeReceiptId(receipt, chainId);
  if (recomputed.toLowerCase() !== receiptId.toLowerCase()) {
    return fail(
      "trial receipt",
      "the stored fields do not reproduce the receipt id, so the record and its identifier disagree",
      { queried: receiptId, recomputed },
    );
  }

  const detail: Record<string, string> = {
    publisher: receipt.publisher,
    "published at": new Date(Number(receipt.publishedAt) * 1000).toISOString(),
    "id recomputed from": "chainId, publisher and every committed field",
  };

  if (evidence.bundle !== undefined) {
    const specHash = canonicalHash(evidence.bundle.trialSpec as unknown as CanonicalValue);
    if (specHash.toLowerCase() !== receipt.trialSpecHash.toLowerCase()) {
      return fail("trial receipt", "the disclosed TrialSpec does not hash to the receipt's trialSpecHash", {
        "on chain": receipt.trialSpecHash,
        disclosed: specHash,
      });
    }
    detail["trial spec"] = specHash;
  }

  if (evidence.artifact !== undefined) {
    if (artifactTrialSpecHash(evidence.artifact).toLowerCase() !== receipt.trialSpecHash.toLowerCase()) {
      return fail(
        "trial receipt",
        "the evidence artifact names a different TrialSpec than the receipt does",
        { "on chain": receipt.trialSpecHash, "in artifact": artifactTrialSpecHash(evidence.artifact) },
      );
    }
  }

  return pass("trial receipt", "published in the registry and its id recomputes from its own fields", detail);
}

function stepAgentIdentity(
  receipt: OnChainReceipt,
  evidence: EvidenceState,
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

  const disclosed = evidence.bundle;
  if (disclosed !== undefined) {
    const spec = disclosed.trialSpec.agent;
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

    const subject = disclosed.testedAuthority.subject.agentIdentity;
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

  if (probe === undefined && disclosed === undefined) {
    return skip(
      "agent identity",
      `nothing to check the receipt's agent against: no contract at ${receipt.identityRegistry} on this chain, and no TrialSpec was disclosed`,
    );
  }

  const how =
    probe === undefined
      ? "matches the disclosed TrialSpec and tested authority; the identity registry has no code on this chain, so on-chain existence was not probed"
      : disclosed === undefined
        ? "the agent exists on the identity registry the receipt names"
        : "the agent exists on chain and matches the disclosed TrialSpec and tested authority";

  return pass("agent identity", how, detail);
}

function stepAgentVersion(receipt: OnChainReceipt, evidence: EvidenceState): Step {
  const bundle = evidence.bundle;
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

  if (bundle.testedAuthority.subject.agentVersionHash.toLowerCase() !== receipt.agentVersionHash.toLowerCase()) {
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
  if (evidence.integrity === undefined) {
    return skip("evidence hash", evidence.unavailable ?? "the evidence document was not retrieved");
  }
  if (!evidence.integrity.ok) {
    return fail("evidence hash", evidence.integrity.reason, {
      "committed to": receipt.evidenceHash,
      "downloaded bytes": evidence.integrity.rawHash,
    });
  }
  const detail: Record<string, string> = {
    uri: receipt.evidenceURI,
    "keccak256(canonical bytes)": evidence.integrity.hash,
    bytes: String(evidence.integrity.byteLength),
    encoding:
      evidence.integrity.encoding === "CANONICAL_BYTES"
        ? "the stored object is the canonical MCJ/1 byte string"
        : "the stored object re-canonicalises to the committed value",
  };
  if (evidence.unavailable !== undefined) {
    // Authentic bytes that this verifier cannot fully interpret.
    return pass("evidence hash", `matches the receipt, though ${evidence.unavailable}`, detail);
  }
  return pass("evidence hash", "the fetched document is what the receipt committed to", detail);
}

function stepReferenceResult(
  receipt: OnChainReceipt,
  evidence: EvidenceState,
  replay: ReplayResult | undefined,
): Step {
  if (evidence.poisoned) {
    return skip("reference result", "the evidence failed its hash check, so nothing in it was read");
  }
  if (evidence.artifact === undefined || replay === undefined) {
    return skip("reference result", evidence.unavailable ?? "no evidence artifact was available to replay");
  }

  const artifact = evidence.artifact;

  if (artifact.environment.forkBlock !== receipt.snapshotBlock.toString(10)) {
    return fail("reference result", "the run was executed at a different block than the receipt pins", {
      "receipt snapshotBlock": receipt.snapshotBlock.toString(10),
      "artifact forkBlock": artifact.environment.forkBlock,
    });
  }

  if (evidence.bundle !== undefined) {
    const spec = evidence.bundle.trialSpec;
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
  }

  if (replay.derived !== artifactResult(artifact)) {
    return fail(
      "reference result",
      `the evidence supports ${replay.derived} but the artifact claims ${artifactResult(artifact)}: ${replay.reasons.join("; ")}`,
    );
  }

  const onChainResult = receipt.passed ? "PASS" : "FAIL";
  if (artifactResult(artifact) !== onChainResult) {
    return fail("reference result", "the artifact's result contradicts the receipt published on chain", {
      "on chain": onChainResult,
      "in artifact": artifactResult(artifact),
    });
  }

  const detail: Record<string, string> = {
    result: artifactResult(artifact),
    "reference model": `${artifactReferenceModelId(artifact)}@${artifactReferenceModelVersion(artifact)}`,
    checks: `${artifactChecks(artifact).length} recorded, ${replay.failedCheckIds.length} failing`,
    expectations: `${replay.expectations.filter((entry) => entry.status === "MATCHED").length}/${replay.expectations.length} matched`,
  };
  if (artifactStateModified(artifact)) {
    detail["environment"] = artifactModificationLabel(artifact) ?? "state modified";
  }

  return pass(
    "reference result",
    `recomputed independently from the trace and the reference model's expectations, and reached ${replay.derived}`,
    detail,
  );
}

function stepTestedAuthority(receipt: OnChainReceipt, evidence: EvidenceState): Step {
  if (evidence.poisoned) {
    return skip("tested authority", "the evidence failed its hash check, so nothing in it was read");
  }
  const bundle = evidence.bundle;
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

  // The envelope embedded in the spec and the one disclosed alongside it must
  // be the same document, or the receipt certifies one thing and the trial
  // asked another.
  const specAuthority = authorityHash(bundle.trialSpec.authority as AuthorityIR);
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

// --- orchestration --------------------------------------------------------

interface TrialStepInput {
  receiptId: Hex;
  receipt: OnChainReceipt;
  chainId: number;
  evidence: EvidenceState;
  replay: ReplayResult | undefined;
  identityProbe: { exists: boolean; owner?: Address } | undefined;
}

function trialSteps(input: TrialStepInput): Step[] {
  return [
    stepAgentIdentity(input.receipt, input.evidence, input.identityProbe),
    stepAgentVersion(input.receipt, input.evidence),
    stepTrialReceipt(input.receiptId, input.receipt, input.chainId, input.evidence),
    stepEvidenceHash(input.receipt, input.evidence),
    stepReferenceResult(input.receipt, input.evidence, input.replay),
    stepTestedAuthority(input.receipt, input.evidence),
  ];
}

async function gatherTrial(
  receiptId: Hex,
  receipt: OnChainReceipt,
  options: VerifyOptions,
): Promise<TrialStepInput> {
  const evidence = await loadEvidence(receipt, options);
  const identityProbe = await probeAgentExists(options.client, {
    registry: receipt.identityRegistry,
    agentId: receipt.agentId,
  });

  return {
    receiptId,
    receipt,
    chainId: options.target.chainId,
    evidence,
    // Each form gets the strongest replay it supports, and both produce the
    // same ReplayResult so every downstream check stays single-implementation.
    // The rich path re-runs the reference model over the disclosed observation
    // rather than comparing figures the publisher chose.
    replay: replayFor(evidence.artifact),
    identityProbe,
  };
}

function networkOf(target: ResolvedTarget): VerificationReport["network"] {
  return {
    chainId: target.chainId,
    name: target.networkName,
    rpcUrl: target.rpcUrl,
    registry: target.registry,
    registrySource: target.registrySource,
  };
}

function finish(
  report: Omit<VerificationReport, "steps" | "verdict"> & { steps: Step[]; stale: boolean },
): VerificationReport {
  const steps = orderSteps(report.subject.kind, report.steps, "not reached");
  return {
    subject: report.subject,
    network: report.network,
    ...(report.receipt === undefined ? {} : { receipt: report.receipt }),
    ...(report.mandate === undefined ? {} : { mandate: report.mandate }),
    steps,
    verdict: decideVerdict({ steps, stale: report.stale }),
    notes: report.notes,
    executions: report.executions,
  };
}

/**
 * Verify a trial receipt.
 *
 * Reports the six steps a receipt can answer. The grant-side steps are absent
 * rather than skipped, because printing them as skipped would say a check could
 * not be performed when in fact there is nothing yet to check — and that would
 * hold every clean receipt at PARTIALLY VERIFIED for a reason that has nothing
 * to do with the receipt.
 */
export async function verifyTrial(receiptId: Hex, options: VerifyOptions): Promise<VerificationReport> {
  const network = networkOf(options.target);

  let receipt: OnChainReceipt;
  try {
    receipt = await readReceipt(options.client, {
      registry: options.target.registry,
      receiptId,
      chainId: options.target.chainId,
    });
  } catch (error) {
    const reason =
      error instanceof UnknownReceiptError
        ? error.message
        : `the registry could not be read: ${String(error)}`;
    return finish({
      subject: { kind: "TRIAL", id: receiptId },
      network,
      steps: [fail("trial receipt", reason)],
      notes: [],
      executions: [],
      stale: false,
    });
  }

  const gathered = await gatherTrial(receiptId, receipt, options);
  const notes: string[] = [];
  if (gathered.evidence.bundle === undefined && gathered.evidence.artifact !== undefined) {
    notes.push(
      `The evidence URI serves a bare evidence artifact rather than a ${"mandate.evidence-bundle/1"} document, so the TrialSpec and the tested AuthorityIR were not disclosed and the authority steps could not run.`,
    );
  }

  notes.push(
    "A trial receipt certifies a tested envelope and grants nothing. The grant, session and execution steps belong to a mandate: run verify:mandate <mandateId>.",
  );

  return finish({
    subject: { kind: "TRIAL", id: receiptId },
    network,
    receipt: summariseReceipt(receiptId, receipt),
    steps: trialSteps(gathered),
    notes,
    executions: [],
    stale: options.now > Number(receipt.freshUntil),
  });
}

/** Verify a mandate: its receipt, its grant, and the two executions that bound it. */
export async function verifyMandate(mandateId: Hex, options: VerifyOptions): Promise<VerificationReport> {
  const network = networkOf(options.target);

  let activation: OnChainActivation;
  try {
    activation = await readActivation(options.client, {
      registry: options.target.registry,
      mandateId,
      chainId: options.target.chainId,
    });
  } catch (error) {
    const reason =
      error instanceof UnknownMandateError
        ? error.message
        : `the registry could not be read: ${String(error)}`;
    return finish({
      subject: { kind: "MANDATE", id: mandateId },
      network,
      steps: [fail("trial receipt", reason)],
      notes: [],
      executions: [],
      stale: false,
    });
  }

  let receipt: OnChainReceipt;
  try {
    receipt = await readReceipt(options.client, {
      registry: options.target.registry,
      receiptId: activation.trialReceiptId,
      chainId: options.target.chainId,
    });
  } catch (error) {
    return finish({
      subject: { kind: "MANDATE", id: mandateId },
      network,
      steps: [
        fail("trial receipt", `the mandate references a receipt the registry cannot produce: ${String(error)}`),
      ],
      notes: [],
      executions: [],
      stale: false,
    });
  }

  const gathered = await gatherTrial(activation.trialReceiptId, receipt, options);
  const sequence = recoverSequence(mandateId, activation, options.target.chainId);
  const { disclosure, problem } = await loadDisclosure(options, activation.disclosureURI);

  const notes: string[] = [
    "The granted AuthorityIR is resolved from the disclosureURI the activation records on chain, and checked against the activation's hash before use. --disclosure overrides the location; it never overrides the hash.",
  ];
  if (problem !== undefined) notes.push(problem);
  if (gathered.evidence.bundle === undefined && gathered.evidence.artifact !== undefined) {
    notes.push(
      "The evidence URI serves a bare evidence artifact, so the tested AuthorityIR was not disclosed and the subset relation could not be recomputed.",
    );
  }

  const grantedStep = stepGrantedAuthority(mandateId, activation, sequence, disclosure, problem);
  const grantAuthenticated = grantedStep.status === "PASS";
  const subsetStep = stepSubsetRelation(gathered.evidence.bundle, disclosure, grantAuthenticated);
  const sessionStep = await stepSessionRegistration(options.client, activation, disclosure, options.now);

  const context: ExecutionContext = {
    wallet: activation.wallet,
    // Only a grant the chain vouches for may widen what counts as a permitted
    // target, so an unauthenticated disclosure contributes none.
    grantedTargets: new Set(
      grantAuthenticated
        ? (disclosure?.grantedAuthority.calls ?? []).map((call) => call.target.toLowerCase() as Address)
        : [],
    ),
  };

  const allowed = await Promise.all(
    (disclosure?.allowedExecutions ?? []).map((entry) =>
      checkAllowedExecution(options.client, context, entry),
    ),
  );
  const blocked = await Promise.all(
    (disclosure?.blockedExecutions ?? []).map((entry) =>
      checkBlockedExecution(options.client, context, entry),
    ),
  );

  const mandate: MandateSummary = {
    mandateId,
    wallet: activation.wallet,
    sessionKeyHash: activation.sessionKeyHash,
    grantedAuthorityHash: activation.grantedAuthorityHash,
    attestedBy: activation.attestedBy,
    activatedAt: Number(activation.activatedAt),
    validFrom: Number(activation.validFrom),
    validUntil: Number(activation.validUntil),
    revokedAt: Number(activation.revokedAt),
    ...(sequence === undefined ? {} : { sequence }),
  };

  return finish({
    subject: { kind: "MANDATE", id: mandateId },
    network,
    receipt: summariseReceipt(activation.trialReceiptId, receipt),
    mandate,
    steps: [
      ...trialSteps(gathered),
      grantedStep,
      subsetStep,
      sessionStep,
      stepAllowedExecution(allowed, disclosure !== undefined),
      stepBlockedExecution(blocked, disclosure !== undefined),
      stepRejectedIntents(disclosure?.rejectedIntents ?? [], disclosure !== undefined),
    ],
    notes,
    executions: [...allowed, ...blocked],
    stale: options.now > Number(receipt.freshUntil),
  });
}

function stepGrantedAuthority(
  mandateId: Hex,
  activation: OnChainActivation,
  sequence: number | undefined,
  disclosure: MandateDisclosure | undefined,
  problem: string | undefined,
): Step {
  if (sequence === undefined) {
    return fail(
      "granted authority",
      `the activation's fields do not reproduce the mandate id at any renewal sequence below ${MAX_SEQUENCE_SCAN}`,
      { "mandate id": mandateId, "granted authority": activation.grantedAuthorityHash },
    );
  }

  if (disclosure === undefined) {
    return skip(
      "granted authority",
      problem ??
        `the activation records no disclosure URI for granted authority ${activation.grantedAuthorityHash}; pass --disclosure <uri> to check a document against it`,
    );
  }

  const hash = authorityHash(disclosure.grantedAuthority);
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
      calls: String(disclosure.grantedAuthority.calls.length),
    },
  );
}

function stepSubsetRelation(
  bundle: EvidenceBundle | undefined,
  disclosure: MandateDisclosure | undefined,
  grantAuthenticated: boolean,
): Step {
  if (bundle === undefined) {
    return skip("subset relation", "the tested AuthorityIR was not disclosed, so nothing can be compared");
  }
  if (disclosure === undefined) {
    return skip("subset relation", "the granted AuthorityIR was not disclosed, so nothing can be compared");
  }
  if (!grantAuthenticated) {
    // Same rule as a bad evidence hash: a document the chain disowned is not
    // evidence of anything, and a verdict computed from it would look like a
    // finding about the mandate when it is only a finding about the file.
    return skip(
      "subset relation",
      "the disclosed grant does not hash to the activation's commitment, so it was not used for anything",
    );
  }

  // Recomputed here rather than read from the compiled mandate's `proof.subset`.
  // A proof a publisher wrote about its own grant is a claim, and this is the
  // one relation the entire product reduces to.
  const result = isSubset(disclosure.grantedAuthority, bundle.testedAuthority);

  if (!result.subset) {
    return fail(
      "subset relation",
      `the granted authority is NOT within the tested authority: ${result.violations.map((violation) => `${violation.rule} at ${violation.path} (${violation.message})`).join("; ")}`,
      { comparator: `${result.comparatorVersion} / ${result.comparatorHash}` },
    );
  }

  return pass("subset relation", "recomputed from both disclosed documents: granted ⊆ tested", {
    comparator: `${result.comparatorVersion} / ${result.comparatorHash}`,
    rules: "re-run locally, not read from the artifact's proof block",
  });
}

/**
 * Was this session actually granted, and what became of it?
 *
 * The activation states the window the grant covered and, once revoked, the
 * moment it ended. That is what makes a finished mandate checkable at all: a
 * revoked session leaves an account holding no key, and an empty account is the
 * same observation for "revoked since activation" and "never granted". Reading
 * the window off the record turns the second case into a reconstruction instead
 * of an unanswerable question, and leaves the account as corroboration.
 *
 * The record is never allowed to overrule the account. A registry that says
 * revoked while the account still holds a live key, or that says live while the
 * account holds nothing inside the window it published, is a contradiction and
 * is reported as one. Those are exactly the states a proof surface must not
 * smooth over.
 */
async function stepSessionRegistration(
  client: PublicClient,
  activation: OnChainActivation,
  disclosure: MandateDisclosure | undefined,
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

  const validFrom = Number(activation.validFrom);
  const validUntil = Number(activation.validUntil);
  const revokedAt = Number(activation.revokedAt);
  const grant = {
    wallet: activation.wallet,
    "key hash": activation.sessionKeyHash,
    "granted from": utcSeconds(validFrom),
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
      // true, not a gap in it. Reporting an expired grant as a discrepancy
      // would make every finished mandate look broken.
      return pass(
        "session registration",
        "the session's window closed and no revocation was recorded, and the account holds no key, which is what the record predicts",
        {
          ...grant,
          "read at block": enforced.observedAtBlock.toString(10),
          "revoked at": "never recorded",
        },
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
    // The activation is a public claim about how long the authority lasts. If
    // the account disagrees, the claim is wrong in whichever direction, and a
    // reader planning around the published window would be planning around a
    // number nothing enforces.
    return fail(
      "session registration",
      "the account expires this key at a different time than the activation committed to",
      {
        ...grant,
        "account expiry": utcSeconds(enforced.expiry),
        "read at block": enforced.observedAtBlock.toString(10),
      },
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
 * an unreachable RPC read as agreement.
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
      reason: `the account at ${activation.wallet} did not answer the permission reads: ${String(error)}`,
    };
  }
}

function stepAllowedExecution(findings: readonly ExecutionFinding[], disclosed: boolean): Step {
  if (findings.length === 0) {
    return skip(
      "allowed execution",
      disclosed
        ? "the disclosure lists no permitted execution"
        : "no disclosure was supplied, so no execution transactions were named",
    );
  }

  const bad = findings.filter((finding) => finding.status !== "CONFIRMED" || finding.linkedToMandate !== true);
  if (bad.length > 0) {
    return fail(
      "allowed execution",
      bad.map((finding) => `${finding.label} (${finding.txHash}): ${finding.summary}`).join("; "),
    );
  }

  return pass(
    "allowed execution",
    `${findings.length} transaction(s) confirmed on chain inside the granted authority`,
    Object.fromEntries(findings.map((finding) => [finding.label, finding.txHash])),
  );
}

function stepBlockedExecution(findings: readonly ExecutionFinding[], disclosed: boolean): Step {
  if (findings.length === 0) {
    return skip(
      "blocked execution",
      disclosed
        ? "the disclosure lists no boundary-crossing execution"
        : "no disclosure was supplied, so no execution transactions were named",
    );
  }

  const wrong = findings.filter((finding) => finding.status === "CONFIRMED");
  if (wrong.length > 0) {
    return fail(
      "blocked execution",
      wrong.map((finding) => `${finding.label} (${finding.txHash}): ${finding.summary}`).join("; "),
    );
  }

  const unattributable = findings.filter((finding) => finding.status !== "REJECTED");
  if (unattributable.length > 0) {
    return skip(
      "blocked execution",
      unattributable.map((finding) => `${finding.label} (${finding.txHash}): ${finding.summary}`).join("; "),
    );
  }

  return pass(
    "blocked execution",
    `${findings.length} transaction(s) refused by the enforcement layer, not by a fault`,
    Object.fromEntries(findings.map((finding) => [finding.label, finding.revert?.name ?? finding.txHash])),
  );
}

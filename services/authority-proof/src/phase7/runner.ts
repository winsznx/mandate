/**
 * One command, the whole lifecycle.
 *
 * The run is split into two lanes for a reason that is not stylistic. The
 * read-only lane — preflight, the trial, the reference replay, the evidence
 * bundle — costs nothing and is worth having before a funded key exists, so a
 * missing key stops the writes and nothing else. A blocker that says the world
 * is not what MANDATE analysed stops everything, because evidence produced
 * against a redeployed contract or a rolled-over spend bucket describes a
 * system nobody wrote down.
 *
 * There is no continuation command. Either the whole sequence runs or it stops
 * at a named step with a manifest saying which one, and the operator starts
 * again once the blocker is gone.
 */
import { createPublicClient, http } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { canonicalHash } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import { authorityHash } from "@mandate/authority-ir";
import { runTrial } from "@mandate/trial-runner";
import { emitTrial } from "@mandate/trial-runner";
import {
  fatalBlocker,
  haltsRun,
  primaryBlocker,
  renderBlocked,
  writeBlocker,
  type Blocker,
} from "./blockers.js";
import { evidenceUriFor, resolveConfig, type NetworkName, type Phase7Config } from "./config.js";
import {
  DISCLOSURE_FILENAME,
  MANIFEST_FILENAME,
  artifactDirectoryFor,
  writeArtifact,
  writeManifest,
  type ExecutionRecord,
  type Phase7RunStatus,
  type TrialSummary,
} from "./manifest.js";
import {
  EVIDENCE_MAX_AGE_SECONDS,
  agentVersionHashOf,
  buildTestedAuthority,
  buildTrialSpec,
  loadVenusProfile,
} from "./plan.js";
import { runPreflight, type PreflightFacts } from "./preflight.js";
import { replayTrialVerdict } from "./replay.js";
import { buildScenario, readMarketParameters, solvePosition } from "./scenario.js";
import { runWriteSequence, type DisclosureInput, type ReceiptFields } from "./sequence.js";
import {
  AGENT_PUBLISHED_ENDPOINT,
  buildTrialRequest,
  createReferenceAgent,
  freshNonce,
  referencePolicy,
  RESTORE_HEALTH_FACTOR_SKILL_ID,
  skillHashesOf,
  trialImplementationHashes,
} from "./trial.js";
import { Phase7Journal, summarizeSteps, type Phase7StepResult } from "./steps.js";

export const MANDATE_DISCLOSURE_SCHEMA_VERSION = "mandate.mandate-disclosure/1" as const;

/** How far behind the head to pin the fork. Inside the public RPC's retention, far enough to be stable. */
export const FORK_PIN_DEPTH = 200n;

/**
 * Where the trial's position should open, 1e18.
 *
 * Below the policy's 1.30 intervention threshold by enough that a block of
 * accrued interest cannot lift it back over, and above 1.0 so the account is
 * never liquidatable while the trial runs.
 */
export const OPENING_HEALTH_FACTOR_MANTISSA = 1_250_000_000_000_000_000n;

/** The repayment the scenario is sized to imply. Comfortably inside the 25-unit tested cap. */
export const DESIRED_REPAY_RAW = 18_000_000n;

export interface RunOutcome {
  status: Phase7RunStatus;
  exitCode: number;
  lines: string[];
  manifestPath: string;
}

function runIdFor(startedAt: number): string {
  return new Date(startedAt * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * The disclosure a verifier resolves the granted authority from.
 *
 * The successful executions and the rejected ones are listed separately, because
 * the verifier re-reads both from chain and a proof that only showed the
 * successes would be showing half the claim.
 */
function disclosureDocument(input: DisclosureInput): CanonicalValue {
  const withHash = input.executions.filter(
    (record): record is ExecutionRecord & { txHash: Hex } => record.txHash !== undefined,
  );
  return {
    schemaVersion: MANDATE_DISCLOSURE_SCHEMA_VERSION,
    grantedAuthority: input.grantedAuthority as unknown as CanonicalValue,
    session: {
      wallet: input.wallet,
      keyHash: input.keyHash,
      ...(input.grantTxHash === undefined ? {} : { grantTxHash: input.grantTxHash }),
    },
    allowedExecutions: withHash
      .filter((record) => record.status === "SUCCESS")
      .map((record) => ({ txHash: record.txHash, label: record.label })),
    blockedExecutions: withHash
      .filter((record) => record.status === "REVERTED")
      .map((record) => ({ txHash: record.txHash, label: record.label })),
  };
}

/** Run the whole thing. Never throws for an expected outcome; only for a bug. */
export async function runPhase7(network: NetworkName, env = process.env): Promise<RunOutcome> {
  const startedAt = Math.floor(Date.now() / 1000);
  const runId = runIdFor(startedAt);
  const config: Phase7Config = resolveConfig(network, env);
  const journal = new Phase7Journal();
  const client = createPublicClient({ transport: http(config.rpcUrl) }) as PublicClient;

  const lines: string[] = [];
  const artifacts: string[] = [];
  const executions: ExecutionRecord[] = [];
  let trial: TrialSummary | undefined;
  let receipt: Awaited<ReturnType<typeof runWriteSequence>>["receipt"];
  let mandate: Awaited<ReturnType<typeof runWriteSequence>>["mandate"];
  let verifier: { trialVerdict: string; mandateVerdict: string; trialExitCode: number; mandateExitCode: number } | undefined;

  const preflight = await runPreflight(journal, config, client, BigInt(startedAt));
  const blockers: Blocker[] = [...preflight.blockers];
  lines.push(...preflight.lines);

  const finish = (status: Phase7RunStatus, exitCode: number): RunOutcome => {
    const resumePoint = journal.resumePoint();
    const written = writeManifest({
      runId,
      config,
      status,
      startedAt,
      finishedAt: Math.floor(Date.now() / 1000),
      blockers,
      steps: journal.all(),
      facts: preflight.facts,
      resumePoint,
      trial,
      receipt,
      mandate,
      executions,
      verifier,
      artifacts: [...artifacts, `${artifactDirectoryFor(runId).relative}/${MANIFEST_FILENAME}`],
    });
    return { status, exitCode, lines, manifestPath: written.relativePath };
  };

  const stopBlocked = (): RunOutcome => {
    const blocker = primaryBlocker(blockers);
    if (blocker === undefined) throw new Error("stopBlocked called with no blocker");
    journal.skipRemaining(`stopped: ${blocker.reason}`);
    lines.push("", renderBlocked(blocker, { name: config.networkName, chainId: config.chainId }));
    return finish("BLOCKED", 1);
  };

  if (haltsRun(blockers)) return stopBlocked();

  // ---- the read-only lane --------------------------------------------------
  journal.begin("reference-agent");
  const executor = createReferenceAgent(config.chainId, config.rpcUrl);
  if (!executor.skills.some((skill) => skill.id === RESTORE_HEALTH_FACTOR_SKILL_ID)) {
    journal.fail("reference-agent", `${executor.slug} does not declare ${RESTORE_HEALTH_FACTOR_SKILL_ID}`);
    blockers.push(
      writeBlocker("REFERENCE_AGENT_UNAVAILABLE", [
        ["agent", executor.slug],
        ["expectedSkill", RESTORE_HEALTH_FACTOR_SKILL_ID],
      ]),
    );
    return stopBlocked();
  }
  const agentVersionHash = agentVersionHashOf(executor);
  journal.pass("reference-agent", `${executor.slug} declares ${executor.skills.length} skill(s)`, [
    { label: "agentVersionHash", value: agentVersionHash },
    { label: "endpoint", value: AGENT_PUBLISHED_ENDPOINT },
  ]);

  journal.begin("trial-spec");
  const profile = loadVenusProfile(config.chainId);
  const protocolVersionHash = profile.implementationCodeHash ?? profile.runtimeCodeHash;
  const agentIdentity = { identityRegistry: config.identityRegistry, agentId: config.agentId };
  const testedAuthority = buildTestedAuthority({
    chainId: config.chainId,
    vToken: config.venus.vToken,
    underlying: config.venus.underlying,
    protocolVersionHash,
    agentIdentity,
    agentVersionHash,
  });

  const pinBlock = preflight.facts.blockNumber - FORK_PIN_DEPTH;
  const parameters = await readMarketParameters(client, config.venus, pinBlock);
  const policy = referencePolicy();
  const sizing = solvePosition({
    parameters,
    openingHealthFactorMantissa: OPENING_HEALTH_FACTOR_MANTISSA,
    targetHealthFactorMantissa: policy.targetHealthFactorMantissa,
    desiredRepayRaw: DESIRED_REPAY_RAW,
    underlyingUnit: 10n ** BigInt(config.venus.underlyingDecimals),
  });
  const build = buildScenario({
    rpcUrl: config.rpcUrl,
    deployment: config.venus,
    blockNumber: pinBlock,
    sizing,
  });

  const hashes = trialImplementationHashes();
  const taskParameters = { account: build.scenario.account, market: config.venus.vToken };
  const trialSpec = buildTrialSpec({
    chainId: config.chainId,
    snapshotBlock: pinBlock,
    nonce: freshNonce(),
    agentIdentity,
    agentVersionHash,
    registrationUriHash: canonicalHash(config.agentRegistrationUri),
    endpointHash: canonicalHash(AGENT_PUBLISHED_ENDPOINT),
    skillHashes: skillHashesOf(executor),
    testedAuthority,
    scenarioId: build.scenario.scenarioId,
    scenarioVersion: build.scenario.version,
    scenarioHash: build.scenarioHash,
    evaluatorCodeHash: hashes.evaluatorCodeHash,
    referenceModelHash: hashes.referenceModelHash,
    taskInputHash: canonicalHash(taskParameters),
    taskParametersHash: canonicalHash({
      policyId: policy.policyId,
      interventionThresholdMantissa: policy.interventionThresholdMantissa.toString(10),
      targetHealthFactorMantissa: policy.targetHealthFactorMantissa.toString(10),
      minimumRepayUsdMantissa: policy.minimumRepayUsdMantissa.toString(10),
      amountToleranceBps: policy.amountToleranceBps,
    }),
    createdAt: startedAt,
  });
  const trialSpecHash = canonicalHash(trialSpec as unknown as CanonicalValue);

  lines.push(
    `${"scenario".padEnd(32)}supply ${sizing.supplyRaw} raw, borrow ${sizing.borrowRaw} raw, implies a ${sizing.impliedRepayRaw} raw repayment`,
  );
  journal.pass("trial-spec", `frozen at ${trialSpecHash}`, [
    { label: "trialSpecHash", value: trialSpecHash },
    { label: "scenarioHash", value: build.scenarioHash },
    { label: "snapshotBlock", value: pinBlock.toString(10) },
    { label: "testedAuthorityHash", value: authorityHash(testedAuthority) },
  ]);

  journal.begin("trial-run");
  const outcome = await runTrial(
    buildTrialRequest({
      chainId: config.chainId,
      build,
      trialSpec,
      parameters: taskParameters,
    }),
  );

  if (outcome.status === "ERROR") {
    // A trial that could not run halts everything: there is no evidence to
    // publish and no verdict to derive a mandate from, whatever else is present.
    journal.fail("trial-run", `${outcome.kind}: ${outcome.detail}`);
    blockers.push(
      fatalBlocker("TRIAL_DID_NOT_RUN", [
        ["kind", outcome.kind],
        ["detail", outcome.detail],
        ["pausesQueue", String(outcome.pausesQueue)],
      ]),
    );
    return stopBlocked();
  }

  journal.pass(
    "trial-run",
    `${outcome.evidence.evaluator.result} on a ${outcome.evidence.environment.rpcSourceClass} fork at block ${outcome.evidence.environment.forkBlock}`,
    [
      { label: "forkBlock", value: outcome.evidence.environment.forkBlock },
      { label: "rpcSourceClass", value: outcome.evidence.environment.rpcSourceClass },
      { label: "evidenceBundleHash", value: outcome.bundleHash },
      { label: "trialEvidenceHash", value: outcome.evidenceHash },
    ],
  );

  journal.begin("reference-replay");
  const replay = replayTrialVerdict(outcome.evidence);
  const replayAgrees = replay.derived === outcome.evidence.evaluator.result;
  const replayEvidence = replay.reasons.map((reason, index) => ({
    label: `reason-${index}`,
    value: reason,
  }));
  if (replayAgrees) {
    journal.pass(
      "reference-replay",
      `recomputed ${replay.derived} from the evidence without reading the stated result`,
      replayEvidence,
    );
  } else {
    journal.fail(
      "reference-replay",
      `the evidence supports ${replay.derived} but the run recorded ${outcome.evidence.evaluator.result}`,
      replayEvidence,
    );
  }

  journal.begin("trial-verdict");
  const passed = outcome.evidence.evaluator.result === "PASS" && replayAgrees;
  trial = {
    trialSpecHash,
    testedAuthorityHash: outcome.testedAuthorityHash,
    evidenceBundleHash: outcome.bundleHash,
    trialEvidenceHash: outcome.evidenceHash,
    scenarioHash: build.scenarioHash,
    forkBlock: outcome.evidence.environment.forkBlock,
    rpcSourceClass: outcome.evidence.environment.rpcSourceClass,
    result: outcome.evidence.evaluator.result,
    replayDerived: replay.derived,
  };

  const directory = artifactDirectoryFor(runId);
  const emitted = await emitTrial(outcome, directory.absolute);
  artifacts.push(
    `${directory.relative}/evidence-bundle.json`,
    `${directory.relative}/trial-evidence.json`,
    `${directory.relative}/receipt-fields.json`,
  );
  void emitted;

  if (!passed) {
    // A failed trial can never back a live mandate; the registry enforces that
    // on chain and there is nothing to gain by finding out the hard way.
    journal.fail(
      "trial-verdict",
      `${outcome.evidence.evaluator.result} with replay ${replay.derived}: ${outcome.evidence.evaluator.failureReason ?? "no reason recorded"}`,
    );
    journal.skipRemaining("the trial did not pass, so no mandate may be derived from it");
    lines.push("", `TRIAL DID NOT PASS: ${outcome.evidence.evaluator.failureReason ?? replay.reasons.join("; ")}`);
    return finish("FAILED", 1);
  }

  journal.pass("trial-verdict", "PASS, and the replay agrees", [
    { label: "result", value: outcome.evidence.evaluator.result },
    { label: "replayDerived", value: replay.derived },
  ]);

  // ---- the boundary --------------------------------------------------------
  if (blockers.length > 0) return stopBlocked();

  if (!config.confirmed) {
    journal.skipRemaining("PROOF_CONFIRM=1 was not set, so the run stopped before the first write");
    lines.push(
      "",
      "Preflight passed and the trial produced a passing receipt. The next step publishes it on chain.",
      "Granting a session spends real tBNB and cannot be undone.",
      "Set PROOF_CONFIRM=1 to execute the write sequence.",
      "",
      "Halted before the first write. Nothing was published, granted or spent.",
    );
    return finish("INCOMPLETE", 0);
  }

  // ---- the write lane ------------------------------------------------------
  const registry = config.registryAddress as Address;
  const wallet = (config.walletAddress ?? preflight.facts.deployerAddress) as Address;
  const evidenceURI = evidenceUriFor(config, runId, "evidence-bundle.json");

  const receiptFields: ReceiptFields = {
    identityRegistry: config.identityRegistry,
    agentId: BigInt(config.agentId),
    agentVersionHash,
    trialSpecHash,
    testedAuthorityHash: outcome.testedAuthorityHash,
    scenarioHash: build.scenarioHash,
    evaluatorHash: hashes.evaluatorCodeHash,
    referenceModelHash: hashes.referenceModelHash,
    evidenceHash: outcome.bundleHash,
    snapshotBlock: pinBlock,
    createdAt: BigInt(startedAt),
    freshUntil: BigInt(startedAt + EVIDENCE_MAX_AGE_SECONDS),
    passed: true,
  };

  const sequence = await runWriteSequence({
    journal,
    config,
    client,
    registry,
    wallet,
    profile,
    testedAuthority,
    allowance: preflight.facts.allowance,
    receiptFields,
    evidenceURI,
    bucketStart: (preflight.facts as PreflightFacts).bucket?.bucketStart ?? 0n,
    now: startedAt,
    writeDisclosure: (input) => {
      const relativePath = writeArtifact(runId, DISCLOSURE_FILENAME, disclosureDocument(input));
      artifacts.push(relativePath);
      return { uri: evidenceUriFor(config, runId, DISCLOSURE_FILENAME), relativePath };
    },
  });

  executions.push(...sequence.executions);
  receipt = sequence.receipt;
  mandate = sequence.mandate;

  if (sequence.haltReason !== undefined) {
    journal.skipRemaining(`stopped: ${sequence.haltReason}`);
    lines.push("", `STOPPED: ${sequence.haltReason}`);
    return finish("FAILED", 1);
  }

  // ---- the independent check -----------------------------------------------
  journal.begin("independent-verifier");
  verifier = await runIndependentVerifier({
    config,
    registry,
    receiptId: receipt?.receiptId,
    mandateId: mandate?.mandateId,
    disclosureUri: mandate?.disclosureURI,
  });
  const verifierEvidence = [
    { label: "trialVerdict", value: verifier.trialVerdict },
    { label: "mandateVerdict", value: verifier.mandateVerdict },
  ];
  if (verifier.trialExitCode === 0 && verifier.mandateExitCode === 0) {
    journal.pass("independent-verifier", "VERIFIED from chain and evidence alone", verifierEvidence);
  } else {
    journal.fail(
      "independent-verifier",
      `trial ${verifier.trialVerdict}, mandate ${verifier.mandateVerdict}`,
      verifierEvidence,
    );
  }

  journal.begin("proof-manifest");
  const status: Phase7RunStatus = journal
    .all()
    .filter((step: Phase7StepResult) => step.id !== "proof-manifest")
    .every((step) => step.status === "PASS")
    ? "PASS"
    : "FAILED";
  journal.pass("proof-manifest", `written to ${artifactDirectoryFor(runId).relative}/${MANIFEST_FILENAME}`);

  lines.push("", summarizeSteps(journal.all()));
  return finish(status, status === "PASS" ? 0 : 1);
}

/**
 * Run the verifier in-process, against the ids that were just published.
 *
 * In-process rather than as a subprocess so a failure surfaces as a value rather
 * than as an exit code nobody captured. It is still the same code path a judge
 * runs from a checkout: the verifier reaches no MANDATE database or API, by
 * construction, and passing it the ids gives it nothing it could not read itself.
 */
async function runIndependentVerifier(params: {
  config: Phase7Config;
  registry: Address;
  receiptId?: Hex | undefined;
  mandateId?: Hex | undefined;
  disclosureUri?: string | undefined;
}): Promise<{ trialVerdict: string; mandateVerdict: string; trialExitCode: number; mandateExitCode: number }> {
  const { createClient, exitCodeFor, resolveTarget, verifyMandate, verifyTrial } = await import(
    "@mandate/verifier"
  );

  const target = resolveTarget({
    chainId: params.config.chainId,
    rpcUrl: params.config.rpcUrl,
    registry: params.registry,
  });
  const client = await createClient(target);
  const now = Math.floor(Date.now() / 1000);

  const trialReport =
    params.receiptId === undefined
      ? undefined
      : await verifyTrial(params.receiptId, { target, client, now });
  const mandateReport =
    params.mandateId === undefined
      ? undefined
      : await verifyMandate(params.mandateId, {
          target,
          client,
          now,
          disclosureUri: params.disclosureUri,
        });

  return {
    trialVerdict: trialReport?.verdict ?? "NOT_RUN",
    mandateVerdict: mandateReport?.verdict ?? "NOT_RUN",
    trialExitCode: trialReport === undefined ? 1 : exitCodeFor(trialReport.verdict),
    mandateExitCode: mandateReport === undefined ? 1 : exitCodeFor(mandateReport.verdict),
  };
}

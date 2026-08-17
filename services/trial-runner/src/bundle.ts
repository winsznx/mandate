/**
 * The disclosure a receipt points at.
 *
 * A receipt stores commitments — `trialSpecHash`, `testedAuthorityHash`,
 * `evidenceHash` — and a hash proves only that nothing changed after
 * publication. Re-running the subset comparator needs the AuthorityIR
 * documents themselves, so the object at `evidenceURI` is a bundle rather than
 * a bare artifact, and `evidenceHash` is the canonical hash of the bundle.
 * Publishing only the artifact leaves the verifier's authority steps
 * permanently skipped and caps every trial at PARTIALLY VERIFIED.
 *
 * `mandate.evidence-bundle/1` is defined by the verifier in
 * `apps/verifier/src/bundle.ts` and mirrored here rather than imported, because
 * a service must not depend on the application that reads its output. The
 * mirror is asserted against the real schema in `test/bundle.test.ts`.
 *
 * KNOWN DIVERGENCE. The bundle's `artifact` slot is typed as the flat
 * `EvidenceArtifact`, which predates the richer `TrialEvidence` this runner
 * produces and cannot carry it — the bundle is `.strict()`, so there is no
 * field to put the fuller document in either. Rather than diverge from a schema
 * another lane owns, the runner projects its artifact down to the flat form and
 * records the full document's hash inside `referenceOutcome.notes`, so the
 * commitment chain still reaches it. That note is a stopgap: the durable fix is
 * for `artifact` to become a union dispatching on `schemaVersion`, which would
 * let the receipt commit to the richer document directly.
 */
import { z } from "zod";
import {
  AuthorityIRSchema,
  EvidenceArtifactSchema,
  EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  TrialSpecSchema,
  canonicalHash,
} from "@mandate/domain";
import type {
  AuthorityIR,
  CanonicalValue,
  EvidenceArtifact,
  EvidenceProvenance,
  RawProtocolObservation,
  TrialEvidence,
  TrialSpec,
} from "@mandate/domain";
import type { Hex } from "viem";

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = "mandate.evidence-bundle/1" as const;

/** Mirror of the verifier's bundle contract. Field names and strictness must match exactly. */
export const EvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_BUNDLE_SCHEMA_VERSION),
    artifact: EvidenceArtifactSchema,
    trialSpec: TrialSpecSchema,
    testedAuthority: AuthorityIRSchema,
  })
  .strict();

export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export class BundleAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleAssemblyError";
  }
}

/** Label binding the flat artifact to the full document it was projected from. */
export const TRIAL_EVIDENCE_NOTE_PREFIX = "mandate.trial-evidence/1 hash: ";

/**
 * Provenance of the evidence, not of the verdict.
 *
 * A pass is what `Trial-verified` means, so a failure cannot carry it. A failed
 * run still establishes that this agent version was observed acting from a
 * bound identity under a frozen spec, which is exactly `Identity-bound`.
 */
function provenanceFor(result: "PASS" | "FAIL"): EvidenceProvenance {
  return result === "PASS" ? "Trial-verified" : "Identity-bound";
}

/**
 * Chain readings worth restating in the flat form.
 *
 * Only positions the account actually holds, plus the protocol's own solvency
 * figures. The full observation lives in the `TrialEvidence` the note points
 * at; repeating forty-six empty markets here would pad the artifact without
 * telling a reader anything.
 */
function stateReadings(observation: RawProtocolObservation): EvidenceArtifact["preState"] {
  const readings: EvidenceArtifact["preState"] = [
    {
      key: "account-liquidity",
      value: observation.accountLiquidity.liquidity,
      unit: "usd-1e18",
      source: "CHAIN",
    },
    {
      key: "account-shortfall",
      value: observation.accountLiquidity.shortfall,
      unit: "usd-1e18",
      source: "CHAIN",
    },
    {
      key: "block-number",
      value: observation.blockNumber,
      unit: "block",
      source: "CHAIN",
    },
  ];

  for (const debt of observation.nonMarketDebt) {
    readings.push({
      key: `non-market-debt-${debt.symbol.toLowerCase()}`,
      value: debt.repayAmount,
      unit: `raw-${debt.decimals}dp`,
      source: "CHAIN",
    });
  }

  for (const market of observation.markets) {
    const collateral = BigInt(market.vTokenBalance ?? "0");
    const borrow = BigInt(market.borrowBalance ?? "0");
    if (collateral === 0n && borrow === 0n) continue;
    readings.push({
      key: `collateral-${market.vToken.slice(2)}`,
      value: market.vTokenBalance ?? "0",
      unit: "vtoken-raw",
      source: "CHAIN",
    });
    readings.push({
      key: `borrow-${market.vToken.slice(2)}`,
      value: market.borrowBalance ?? "0",
      unit: `raw-${market.underlyingDecimals}dp`,
      source: "CHAIN",
    });
  }

  return readings;
}

function referenceReadings(evidence: TrialEvidence): EvidenceArtifact["preState"] {
  const output = evidence.reference.output;
  const readings: EvidenceArtifact["preState"] = [
    {
      key: "reference-risk-state",
      value: output.riskState,
      unit: "state",
      source: "REFERENCE_MODEL",
    },
    {
      key: "reference-weighted-collateral",
      value: output.weightedCollateralUsdMantissa,
      unit: "usd-1e18",
      source: "REFERENCE_MODEL",
    },
    {
      key: "reference-total-borrow",
      value: output.totalBorrowUsdMantissa,
      unit: "usd-1e18",
      source: "REFERENCE_MODEL",
    },
  ];

  if (output.healthFactorMantissa !== null) {
    readings.push({
      key: "reference-health-factor",
      value: output.healthFactorMantissa,
      unit: "ratio-1e18",
      source: "REFERENCE_MODEL",
    });
  }

  if (output.expectedAction !== null) {
    readings.push({
      key: "reference-expected-repay",
      value: output.expectedAction.amount,
      unit: `raw-${output.expectedAction.decimals}dp`,
      source: "REFERENCE_MODEL",
    });
  }

  return readings;
}

/**
 * Project the full artifact down to the flat form the bundle accepts.
 *
 * Lossy by construction, and the loss is named: the full document's hash goes
 * into `referenceOutcome.notes`, so a reader holding the bundle can still
 * demand and verify the richer artifact rather than having to take the summary
 * on trust.
 */
export function toEvidenceArtifact(evidence: TrialEvidence, evidenceHash: Hex): EvidenceArtifact {
  const environment = evidence.environment;
  const modificationLabel = environment.modifications.map((entry) => entry.label).join("; ");

  const document: CanonicalValue = {
    schemaVersion: EVIDENCE_ARTIFACT_SCHEMA_VERSION,
    trialSpecHash: evidence.trialSpec.hash,
    category: evidence.category,
    provenance: provenanceFor(evidence.evaluator.result),
    environment: {
      chainId: environment.chainId,
      forkBlock: environment.forkBlock,
      stateModified: environment.modifiedState,
      ...(modificationLabel === "" ? {} : { modificationLabel }),
      runnerVersion: environment.runnerVersion,
      anvilVersion: environment.anvilVersion,
    },
    invocation: evidence.observations.agentProposal.invocation as unknown as CanonicalValue,
    preState: [
      ...stateReadings(evidence.observations.preState),
      ...referenceReadings(evidence),
    ] as unknown as CanonicalValue,
    trace: evidence.observations.txs.map((tx) => ({
      index: tx.index,
      from: tx.from,
      to: tx.to,
      ...(tx.selector === undefined ? {} : { selector: tx.selector }),
      value: tx.value,
      data: tx.data,
      gasUsed: tx.gasUsed,
      success: tx.status === "SUCCESS",
      ...(tx.revertReason === undefined ? {} : { revertReason: tx.revertReason }),
      blockNumber: tx.blockNumber,
      txHash: tx.txHash,
    })),
    postState: stateReadings(evidence.observations.postState) as unknown as CanonicalValue,
    referenceOutcome: {
      modelId: evidence.reference.output.modelId,
      modelVersion: evidence.reference.output.modelVersion,
      expected: referenceReadings(evidence) as unknown as CanonicalValue,
      notes: [
        `${TRIAL_EVIDENCE_NOTE_PREFIX}${evidenceHash}`,
        `reference implementation: ${evidence.reference.implementationHash}`,
        `evaluator implementation: ${evidence.evaluator.implementationHash}`,
        `rpc source class: ${environment.rpcSourceClass}`,
        ...evidence.reference.output.notes,
      ],
    },
    checks: evidence.evaluator.checks.map((check) => ({
      checkId: check.checkId,
      description: check.description,
      passed: check.status === "PASS",
      ...(check.expected === undefined ? {} : { expected: check.expected }),
      ...(check.observed === undefined ? {} : { observed: check.observed }),
      ...(check.inconclusiveReason === undefined
        ? {}
        : { inconclusiveReason: check.inconclusiveReason }),
    })),
    result: evidence.evaluator.result,
    ...(evidence.evaluator.failureReason === undefined
      ? {}
      : { failureReason: evidence.evaluator.failureReason }),
    observedAt: evidence.observedAt,
  };

  const parsed = EvidenceArtifactSchema.safeParse(document);
  if (!parsed.success) {
    throw new BundleAssemblyError(
      `the projected artifact is not valid evidence: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`,
    );
  }
  return parsed.data;
}

export interface AssembledBundle {
  readonly bundle: EvidenceBundle;
  /** What the receipt's `evidenceHash` must be. Over the bundle, never the bare artifact. */
  readonly bundleHash: Hex;
}

/**
 * Bundle an artifact with the documents a receipt commits to.
 *
 * The tested authority is carried explicitly even though it is also
 * `trialSpec.authority`: the receipt commits to it under its own hash, and a
 * verifier that folded the two together could not report which one diverged.
 */
export function assembleBundle(
  evidence: TrialEvidence,
  evidenceHash: Hex,
  trialSpec: TrialSpec,
): AssembledBundle {
  const testedAuthority: AuthorityIR = trialSpec.authority;

  const document: CanonicalValue = {
    schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    artifact: toEvidenceArtifact(evidence, evidenceHash) as unknown as CanonicalValue,
    trialSpec: trialSpec as unknown as CanonicalValue,
    testedAuthority: testedAuthority as unknown as CanonicalValue,
  };

  const parsed = EvidenceBundleSchema.safeParse(document);
  if (!parsed.success) {
    throw new BundleAssemblyError(
      `the assembled bundle is not valid: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`,
    );
  }

  return {
    bundle: parsed.data,
    bundleHash: canonicalHash(parsed.data as unknown as CanonicalValue),
  };
}

/** Re-derive a bundle's hash, the way a verifier does before reading it. */
export function bundleHashOf(bundle: EvidenceBundle): Hex {
  return canonicalHash(bundle as unknown as CanonicalValue);
}

/** The canonical hash of a frozen spec, which the receipt's `trialSpecHash` must equal. */
export function trialSpecHashOf(trialSpec: TrialSpec): Hex {
  return canonicalHash(trialSpec as unknown as CanonicalValue);
}

/** The canonical hash of the tested envelope, which the receipt's `testedAuthorityHash` must equal. */
export function testedAuthorityHashOf(authority: AuthorityIR): Hex {
  return canonicalHash(authority as unknown as CanonicalValue);
}

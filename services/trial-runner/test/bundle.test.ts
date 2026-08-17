import { describe, expect, it } from "vitest";
import { canonicalHash } from "@mandate/domain";
import type { CanonicalValue, TrialEvidence } from "@mandate/domain";
import { GOLDEN_TRIAL_SPEC } from "@mandate/domain/fixtures";
import {
  EvidenceBundleSchema,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  TRIAL_EVIDENCE_NOTE_PREFIX,
  assembleBundle,
  bundleHashOf,
  testedAuthorityHashOf,
  toEvidenceArtifact,
  trialSpecHashOf,
} from "../src/bundle.js";
import { assembleEvidence, type EvidenceInput } from "../src/evidence.js";
import { evaluate } from "../src/evaluator.js";
import { evaluatorImplementationHash } from "../src/identity.js";
import type { ForkHandle } from "../src/anvil.js";
import type { InvocationRecord } from "../src/invoke.js";
import type { Hex } from "viem";
import {
  ACCOUNT,
  AT_RISK,
  REPAY_BORROW_SELECTOR,
  SPEND_CAP_RAW_UNITS,
  VUSDT,
  observation,
  propose,
  reference,
  transaction,
} from "./fixtures.js";

/**
 * The receipt commits to the bundle, never to the bare artifact.
 *
 * A receipt whose `evidenceHash` covers only the artifact leaves a verifier
 * without the AuthorityIR documents it needs to re-run the subset comparator,
 * so its authority steps skip and the verdict is capped at PARTIALLY VERIFIED
 * forever. These tests pin the shape and the hash chain against the verifier's
 * own schema rather than against this package's copy of it.
 */

/**
 * The verifier's own schema, loaded at run time.
 *
 * Deliberately not a static import. A service must not take a build dependency
 * on the application that consumes its output, and a devDependency here would
 * put an app in a service's dependency graph to satisfy one assertion. The
 * specifier is computed so it resolves at run time only, which is exactly the
 * moment the conformance claim needs to hold.
 */
interface ParsesLikeZod {
  safeParse(value: unknown): { success: boolean; error?: { message: string } };
}

const VerifierBundleSchema = (
  (await import(
    new URL("../../../apps/verifier/src/bundle.ts", import.meta.url).href
  )) as { EvidenceBundleSchema: ParsesLikeZod }
).EvidenceBundleSchema;

const CORRECT_AMOUNT = BigInt(reference(AT_RISK).expectedAction?.amount ?? "0");
const SKILL = "restore-health-factor";

function evidence(): { evidence: TrialEvidence; evidenceHash: Hex } {
  const pre = observation(AT_RISK);
  const post = observation({ ...AT_RISK, usdtBorrow: (AT_RISK.usdtBorrow ?? 0n) - CORRECT_AMOUNT });
  const verdict = evaluate({
    preState: pre,
    postState: post,
    proposal: propose(CORRECT_AMOUNT),
    reference: reference(AT_RISK),
    transactions: [transaction({ index: 0 })],
    authorisedTarget: VUSDT,
    authorisedSelector: REPAY_BORROW_SELECTOR,
    spendCapRawUnits: SPEND_CAP_RAW_UNITS,
    agentObservedBlock: pre.blockNumber,
  });
  if (verdict.status !== "COMPLETE") throw new Error("the fixture run must reach a verdict");

  const fork: ForkHandle = {
    endpoint: "http://127.0.0.1:8545",
    port: 8545,
    blockNumber: 125_598_995n,
    blockHash: `0x${"c".repeat(64)}` as Hex,
    rpcSourceClass: "archive",
    anvilVersion: "anvil Version: 1.7.1",
    stop: async () => {},
  };

  const invocation: InvocationRecord = {
    requestId: "7f6e5d4c-3b2a-4190-8877-665544332211",
    proposal: propose(CORRECT_AMOUNT),
    endpointHash: `0x${"d".repeat(64)}` as Hex,
    requestHash: `0x${"e".repeat(64)}` as Hex,
    responseHash: `0x${"f".repeat(64)}` as Hex,
    observationsHash: `0x${"1".repeat(64)}` as Hex,
    latencyMs: 412,
    protocol: "REFERENCE",
  };

  const input: EvidenceInput = {
    category: GOLDEN_TRIAL_SPEC.category,
    trialSpecHash: trialSpecHashOf(GOLDEN_TRIAL_SPEC),
    fork,
    chainId: 97,
    modifications: [],
    agent: {
      identityRegistry: GOLDEN_TRIAL_SPEC.agent.identityRegistry,
      agentId: GOLDEN_TRIAL_SPEC.agent.agentId,
      agentVersionHash: GOLDEN_TRIAL_SPEC.agent.agentVersionHash,
    },
    invocation,
    preState: pre,
    postState: post,
    transactions: [transaction({ index: 0 })],
    referenceImplementationHash: `0x${"b".repeat(64)}` as Hex,
    referenceInputsHash: `0x${"3".repeat(64)}` as Hex,
    reference: reference(AT_RISK),
    evaluatorImplementationHash: evaluatorImplementationHash(),
    checks: verdict.checks,
    result: verdict.result,
    observedAt: 1_786_500_000,
  };

  return assembleEvidence(input, ACCOUNT, SKILL);
}

const built = evidence();
const assembled = assembleBundle(built.evidence, built.evidenceHash, GOLDEN_TRIAL_SPEC);

describe("the mirrored bundle contract matches the verifier's", () => {
  it("produces a bundle the verifier's own schema accepts", () => {
    // #given a bundle this runner assembled against its local mirror
    // #when it is validated with the schema the verifier actually uses
    const parsed = VerifierBundleSchema.safeParse(assembled.bundle);

    // #then it passes. The mirror exists so the service does not depend on the
    // application that reads it; this is what stops the two drifting.
    expect(parsed.error?.message ?? "ok").toBe("ok");
  });

  it("declares the schema version the verifier dispatches on", () => {
    // #given the verifier reading the document at evidenceURI
    // #then it recognises a bundle rather than degrading to artifact-only,
    // which is what silently skips the authority steps
    expect(assembled.bundle.schemaVersion).toBe(EVIDENCE_BUNDLE_SCHEMA_VERSION);
    expect(EVIDENCE_BUNDLE_SCHEMA_VERSION).toBe("mandate.evidence-bundle/1");
  });

  it("agrees with the verifier's schema on strictness", () => {
    // #given a bundle carrying an extra field
    const extended = { ...assembled.bundle, extra: true };

    // #then both schemas reject it, so a field added here cannot pass locally
    // and fail in the verifier
    expect(EvidenceBundleSchema.safeParse(extended).success).toBe(false);
    expect(VerifierBundleSchema.safeParse(extended).success).toBe(false);
  });
});

describe("the documents a receipt commits to", () => {
  it("carries the frozen spec, hashing to the receipt's trialSpecHash", () => {
    // #given the bundle
    // #then the spec is disclosed in full and its hash is reproducible
    expect(assembled.bundle.trialSpec.schemaVersion).toBe(GOLDEN_TRIAL_SPEC.schemaVersion);
    expect(canonicalHash(assembled.bundle.trialSpec as unknown as CanonicalValue)).toBe(
      trialSpecHashOf(GOLDEN_TRIAL_SPEC),
    );
  });

  it("carries the tested authority in full, not only inside the spec", () => {
    // #given the bundle
    // #then the envelope is a top-level document. The receipt commits to it
    // under its own hash, and a verifier that folded the two together could not
    // report which one diverged.
    expect(assembled.bundle.testedAuthority.chainId).toBe(GOLDEN_TRIAL_SPEC.chain.chainId);
    expect(canonicalHash(assembled.bundle.testedAuthority as unknown as CanonicalValue)).toBe(
      testedAuthorityHashOf(GOLDEN_TRIAL_SPEC.authority),
    );
  });

  it("gives the verifier both authority documents it needs to re-run the comparator", () => {
    // #given the bundle alone
    // #then the tested envelope is present as a document rather than a hash,
    // which is the whole reason the bundle exists
    expect(assembled.bundle.testedAuthority.calls.length).toBeGreaterThan(0);
    expect(assembled.bundle.testedAuthority.spend.length).toBeGreaterThan(0);
  });
});

describe("the hash chain", () => {
  it("hashes the bundle, not the bare artifact", () => {
    // #given the two candidate commitments
    const artifactOnly = canonicalHash(assembled.bundle.artifact as unknown as CanonicalValue);

    // #then the receipt's evidenceHash is the bundle's, and the two differ. A
    // receipt carrying the artifact hash would fail the verifier's own
    // integrity step before it ever reached the authority steps.
    expect(assembled.bundleHash).toBe(bundleHashOf(assembled.bundle));
    expect(assembled.bundleHash).not.toBe(artifactOnly);
  });

  it("stays stable across assemblies of the same run", () => {
    // #given the same evidence bundled twice
    const again = assembleBundle(built.evidence, built.evidenceHash, GOLDEN_TRIAL_SPEC);

    // #then the commitment does not move
    expect(again.bundleHash).toBe(assembled.bundleHash);
  });

  it("binds the full artifact the projection was made from", () => {
    // #given the flat artifact inside the bundle
    const note = assembled.bundle.artifact.referenceOutcome.notes.find((entry) =>
      entry.startsWith(TRIAL_EVIDENCE_NOTE_PREFIX),
    );

    // #then it names the richer document's hash, so a reader holding only the
    // bundle can still demand and verify the full evidence rather than taking
    // the summary on trust. This is a stopgap for the bundle's `artifact` slot
    // being typed as the flat schema.
    expect(note).toBe(`${TRIAL_EVIDENCE_NOTE_PREFIX}${built.evidenceHash}`);
  });
});

describe("the projection to the flat artifact", () => {
  it("preserves the verdict and every check", () => {
    // #given the projected artifact
    const artifact = assembled.bundle.artifact;

    // #then the outcome and the checks behind it survive intact
    expect(artifact.result).toBe(built.evidence.evaluator.result);
    expect(artifact.checks).toHaveLength(built.evidence.evaluator.checks.length);
    expect(artifact.checks.every((check) => check.passed)).toBe(true);
  });

  it("preserves the transaction trace", () => {
    // #given the projected artifact
    // #then every transaction is present with its success flag
    expect(assembled.bundle.artifact.trace).toHaveLength(built.evidence.observations.txs.length);
    expect(assembled.bundle.artifact.trace[0]?.success).toBe(true);
  });

  it("carries the reference model's figures as reference-sourced readings", () => {
    // #given the projected artifact's pre-state
    const modelled = assembled.bundle.artifact.preState.filter(
      (reading) => reading.source === "REFERENCE_MODEL",
    );

    // #then the model's conclusion is attributed to the model rather than
    // presented as something the chain said
    expect(modelled.length).toBeGreaterThan(0);
    expect(modelled.map((reading) => reading.key)).toContain("reference-risk-state");
  });

  it("records the rpc source class where a flat reader can see it", () => {
    // #given a projection of a run whose fork was head-pinned
    const degraded: TrialEvidence = {
      ...built.evidence,
      environment: {
        ...built.evidence.environment,
        rpcSourceClass: "live",
        rpcDegradedReason: "the RPC has pruned the state at the pinned block",
      },
    };
    const artifact = toEvidenceArtifact(degraded, built.evidenceHash);

    // #then the disclosure survives the projection. The flat schema has no
    // field for it, and dropping it would turn an honest degradation into a
    // silent one.
    expect(artifact.referenceOutcome.notes).toContain("rpc source class: live");
  });

  it("labels a modified environment in the flat form too", () => {
    // #given a run that shocked the oracle
    const shocked: TrialEvidence = {
      ...built.evidence,
      environment: {
        ...built.evidence.environment,
        modifiedState: true,
        modifications: [
          {
            label: "SIMULATED ORACLE SHOCK",
            kind: "SET_ORACLE_PRICE",
            target: "0x3cd69251d04a28d887ac14cbe2e14c52f3d57823",
            rpcMethod: "anvil_setStorageAt",
            detail: "slot 0x04 written",
          },
        ],
      },
    };
    const artifact = toEvidenceArtifact(shocked, built.evidenceHash);

    // #then the label travels, which the flat schema independently requires
    expect(artifact.environment.stateModified).toBe(true);
    expect(artifact.environment.modificationLabel).toBe("SIMULATED ORACLE SHOCK");
  });

  it("does not describe a failed run as trial-verified", () => {
    // #given a projection of a failing run
    const failing: TrialEvidence = {
      ...built.evidence,
      evaluator: {
        ...built.evidence.evaluator,
        checks: [
          {
            checkId: "action-target-authorised",
            description: "target",
            status: "FAIL",
            expected: "a",
            observed: "b",
          },
          ...built.evidence.evaluator.checks.slice(1),
        ],
        result: "FAIL",
        failureReason: "the proposal targeted a market outside the tested authority",
      },
    };
    const artifact = toEvidenceArtifact(failing, built.evidenceHash);

    // #then the provenance says the identity was bound and observed, not that
    // anything passed. `Trial-verified` means a pass, and a failure may not
    // borrow it.
    expect(artifact.provenance).toBe("Identity-bound");
    expect(artifact.result).toBe("FAIL");
  });
});

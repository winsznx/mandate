/**
 * Documents a publisher would produce, built the way a publisher builds them.
 *
 * The point of hashing here rather than reusing anything the verifier computes
 * is that the two sides must arrive at the same value independently. A fixture
 * that called the verifier's own helpers to decide what the receipt commits to
 * would test nothing.
 */
import { canonicalBytes, canonicalHash } from "@mandate/domain/canonical";
import type { CanonicalValue } from "@mandate/domain/canonical";
import { authorityHash } from "@mandate/authority-ir";
import {
  GOLDEN_GRANTED_AUTHORITY,
  GOLDEN_TESTED_AUTHORITY,
  GOLDEN_TRIAL_SPEC,
} from "@mandate/domain/fixtures";
import type { AuthorityIR } from "@mandate/domain";
import { keccak256, toHex } from "viem";
import type { Hex } from "viem";

export const SNAPSHOT_BLOCK = "40000000";

function placeholder(nibble: string): Hex {
  return `0x${nibble.repeat(64)}` as Hex;
}

/** The trial spec every fixture receipt refers to, and its commitment. */
export const TRIAL_SPEC = GOLDEN_TRIAL_SPEC;
export const TRIAL_SPEC_HASH = canonicalHash(TRIAL_SPEC as unknown as CanonicalValue);
export const TESTED_AUTHORITY = GOLDEN_TESTED_AUTHORITY;
export const TESTED_AUTHORITY_HASH = authorityHash(TESTED_AUTHORITY);
export const GRANTED_AUTHORITY = GOLDEN_GRANTED_AUTHORITY;
export const GRANTED_AUTHORITY_HASH = authorityHash(GRANTED_AUTHORITY);

/**
 * A grant that widens the tested envelope instead of tightening it.
 *
 * The spend limit is doubled, which is the violation a user is most likely to
 * request and the one a verifier must never wave through.
 */
export const OVERBROAD_AUTHORITY: AuthorityIR = {
  ...GRANTED_AUTHORITY,
  spend: [
    {
      token: "0x3333333333333333333333333333333333333333",
      limit: "100000000000000000000",
      period: "day",
    },
  ],
};
export const OVERBROAD_AUTHORITY_HASH = authorityHash(OVERBROAD_AUTHORITY);

interface ArtifactOptions {
  result: "PASS" | "FAIL";
  /** Set to make the run's post-state contradict the reference model. */
  observedHealthFactor?: string;
}

const EXPECTED_HEALTH_FACTOR = "1.31";

export function buildArtifact(options: ArtifactOptions): Record<string, unknown> {
  const observed = options.observedHealthFactor ?? EXPECTED_HEALTH_FACTOR;
  const restored = observed === EXPECTED_HEALTH_FACTOR;

  return {
    schemaVersion: "mandate.evidence/1",
    trialSpecHash: TRIAL_SPEC_HASH,
    category: "HEALTH_FACTOR",
    provenance: "Trial-verified",
    environment: {
      chainId: 97,
      forkBlock: SNAPSHOT_BLOCK,
      stateModified: true,
      modificationLabel: "SIMULATED ORACLE SHOCK",
      runnerVersion: "1.0.0",
      anvilVersion: "1.7.1",
    },
    invocation: {
      protocol: "REFERENCE",
      endpointHash: placeholder("3"),
      requestHash: placeholder("5"),
      responseHash: placeholder("6"),
      latencyMs: 812,
      reportedVersion: "1.0.0",
      outcome: "OK",
    },
    preState: [{ key: "health-factor", value: "0.94", unit: "ratio", source: "CHAIN" }],
    trace: [
      {
        index: 0,
        from: "0x4444444444444444444444444444444444444444",
        to: "0x2222222222222222222222222222222222222222",
        selector: "0x0e752702",
        value: "0",
        data: "0x0e75270200000000000000000000000000000000000000000000000000000000017d7840",
        gasUsed: "184213",
        success: true,
        blockNumber: "40000001",
      },
    ],
    postState: [{ key: "health-factor", value: observed, unit: "ratio", source: "CHAIN" }],
    referenceOutcome: {
      modelId: "venus-health-factor",
      modelVersion: "1.0.0",
      expected: [
        { key: "health-factor", value: EXPECTED_HEALTH_FACTOR, unit: "ratio", source: "REFERENCE_MODEL" },
      ],
      notes: [],
    },
    checks: [
      {
        checkId: "health-factor-restored",
        description: "the position's health factor is at or above the configured floor after the run",
        passed: restored,
        expected: EXPECTED_HEALTH_FACTOR,
        observed,
      },
    ],
    result: options.result,
    ...(options.result === "FAIL"
      ? { failureReason: `the health factor settled at ${observed}, below the ${EXPECTED_HEALTH_FACTOR} floor` }
      : {}),
    observedAt: 1_790_000_100,
  };
}

export interface BuiltBundle {
  document: Record<string, unknown>;
  bytes: Uint8Array;
  hash: Hex;
}

/** A full disclosure bundle plus the exact bytes a publisher would store. */
export function buildBundle(options: ArtifactOptions): BuiltBundle {
  const document = {
    schemaVersion: "mandate.evidence-bundle/1",
    artifact: buildArtifact(options),
    testedAuthority: TESTED_AUTHORITY,
    trialSpec: TRIAL_SPEC,
  };
  const bytes = canonicalBytes(document as unknown as CanonicalValue);
  return { document, bytes, hash: keccak256(toHex(bytes)) };
}

export function buildMandateDisclosure(granted: AuthorityIR): Record<string, unknown> {
  return {
    schemaVersion: "mandate.mandate-disclosure/1",
    grantedAuthority: granted,
    allowedExecutions: [],
    blockedExecutions: [],
  };
}

/** Receipt fields as the registry's `Receipt` struct orders them. */
export interface ReceiptFields {
  identityRegistry: Hex;
  agentId: bigint;
  agentVersionHash: Hex;
  trialSpecHash: Hex;
  testedAuthorityHash: Hex;
  scenarioHash: Hex;
  evaluatorHash: Hex;
  referenceModelHash: Hex;
  evidenceHash: Hex;
  snapshotBlock: bigint;
  createdAt: bigint;
  freshUntil: bigint;
  passed: boolean;
}

export function buildReceiptFields(params: { evidenceHash: Hex; passed: boolean }): ReceiptFields {
  return {
    identityRegistry: TRIAL_SPEC.agent.identityRegistry as Hex,
    agentId: BigInt(TRIAL_SPEC.agent.agentId),
    agentVersionHash: TRIAL_SPEC.agent.agentVersionHash,
    trialSpecHash: TRIAL_SPEC_HASH,
    testedAuthorityHash: TESTED_AUTHORITY_HASH,
    scenarioHash: TRIAL_SPEC.scenario.scenarioHash,
    evaluatorHash: TRIAL_SPEC.evaluator.codeHash,
    referenceModelHash: TRIAL_SPEC.evaluator.referenceModelHash,
    evidenceHash: params.evidenceHash,
    snapshotBlock: BigInt(SNAPSHOT_BLOCK),
    createdAt: 1_790_000_000n,
    freshUntil: 1_790_604_800n,
    passed: params.passed,
  };
}

/** Freshness reference point: inside the fixture receipt's validity window. */
export const NOW_WITHIN_FRESHNESS = 1_790_100_000;

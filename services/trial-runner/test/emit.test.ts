import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalHash, TrialEvidenceSchema } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import { GOLDEN_TRIAL_SPEC } from "@mandate/domain/fixtures";
import type { Hex } from "viem";
import { emitTrial, BUNDLE_FILENAME, EVIDENCE_FILENAME, MANIFEST_FILENAME } from "../src/emit.js";
import { assembleBundle, trialSpecHashOf, testedAuthorityHashOf } from "../src/bundle.js";
import { assembleEvidence, type EvidenceInput } from "../src/evidence.js";
import { evaluate } from "../src/evaluator.js";
import { evaluatorImplementationHash } from "../src/identity.js";
import type { ForkHandle } from "../src/anvil.js";
import type { InvocationRecord } from "../src/invoke.js";
import {
  ACCOUNT,
  AT_RISK,
  POLICY,
  REPAY_BORROW_SELECTOR,
  SPEND_CAP_RAW_UNITS,
  VUSDT,
  observation,
  propose,
  reference,
  transaction,
} from "./fixtures.js";

/**
 * What lands on disk has to be what was hashed.
 *
 * A re-serialisation that differs in key order produces bytes a verifier will
 * hash to something else, and the receipt then commits to a document nobody
 * holds. Writing through the canonical encoder is what removes that gap.
 */

const CORRECT_AMOUNT = BigInt(reference(AT_RISK).expectedAction?.amount ?? "0");

function completed() {
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
    referenceInputs: {
      actionableMarket: VUSDT,
      repaySelector: REPAY_BORROW_SELECTOR,
      policy: POLICY,
    },
    reference: reference(AT_RISK),
    evaluatorImplementationHash: evaluatorImplementationHash(),
    checks: verdict.checks,
    result: verdict.result,
    observedAt: 1_786_500_000,
  };

  const built = assembleEvidence(input, ACCOUNT, "restore-health-factor");
  const bundled = assembleBundle(built.evidence, built.evidenceHash, GOLDEN_TRIAL_SPEC);

  return {
    evidence: built.evidence,
    evidenceHash: built.evidenceHash,
    bundle: bundled.bundle,
    bundleHash: bundled.bundleHash,
    trialSpecHash: trialSpecHashOf(GOLDEN_TRIAL_SPEC),
    testedAuthorityHash: testedAuthorityHashOf(GOLDEN_TRIAL_SPEC.authority),
  };
}

const directory = await mkdtemp(join(tmpdir(), "mandate-trial-"));
const trial = completed();
const emitted = await emitTrial(trial, directory);

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("what a trial writes out", () => {
  it("writes the bundle, the full artifact and the receipt fields", () => {
    // #given a completed trial emitted to a directory
    // #then all three files are where the publisher expects them
    expect(emitted.bundlePath).toContain(BUNDLE_FILENAME);
    expect(emitted.evidencePath).toContain(EVIDENCE_FILENAME);
    expect(emitted.manifestPath).toContain(MANIFEST_FILENAME);
  });

  it("writes bytes that hash to the commitment", async () => {
    // #given the bundle as it was written
    const bytes = await readFile(emitted.bundlePath, "utf8");

    // #when a verifier hashes what it received
    // #then it reproduces the receipt's evidenceHash, because the file was
    // written through the canonical encoder rather than re-serialised
    expect(canonicalHash(JSON.parse(bytes) as CanonicalValue)).toBe(trial.bundleHash);
  });

  it("writes a full artifact that validates on its own", async () => {
    // #given the richer document the bundle's summary points at
    const bytes = await readFile(emitted.evidencePath, "utf8");

    // #then it is valid evidence and hashes to the value the bundle recorded
    const parsed = JSON.parse(bytes) as CanonicalValue;
    expect(TrialEvidenceSchema.safeParse(parsed).success).toBe(true);
    expect(canonicalHash(parsed)).toBe(trial.evidenceHash);
  });

  it("names the bundle hash as the receipt's evidenceHash, not the artifact's", async () => {
    // #given the manifest
    const manifest = JSON.parse(await readFile(emitted.manifestPath, "utf8")) as Record<string, string>;

    // #then the publisher is handed the right hash for the right field. A
    // receipt carrying the bare artifact's hash fails the verifier's integrity
    // step before it ever reaches the authority steps.
    expect(manifest["evidenceHash"]).toBe(trial.bundleHash);
    expect(manifest["trialEvidenceHash"]).toBe(trial.evidenceHash);
    expect(manifest["evidenceHash"]).not.toBe(manifest["trialEvidenceHash"]);
  });

  it("carries the other two receipt commitments", async () => {
    // #given the manifest
    const manifest = JSON.parse(await readFile(emitted.manifestPath, "utf8")) as Record<string, string>;

    // #then the spec and authority hashes come from the documents in the
    // bundle, so the commitment and the disclosure cannot disagree
    expect(manifest["trialSpecHash"]).toBe(trial.trialSpecHash);
    expect(manifest["testedAuthorityHash"]).toBe(trial.testedAuthorityHash);
  });

  it("discloses the rpc source class where a publisher will see it", async () => {
    // #given the manifest
    const manifest = JSON.parse(await readFile(emitted.manifestPath, "utf8")) as Record<string, string>;

    // #then whether the fork was archive-sourced is visible at publication
    // time, not buried in the artifact for someone to find afterwards
    expect(manifest["rpcSourceClass"]).toBe("archive");
    expect(manifest["result"]).toBe("PASS");
  });
});

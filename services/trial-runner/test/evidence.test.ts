import { describe, expect, it } from "vitest";
import { TrialEvidenceSchema, canonicalHash } from "@mandate/domain";
import type { CanonicalValue, StateModification } from "@mandate/domain";
import type { Hex } from "viem";
import { assembleEvidence, evidenceHashOf, EvidenceAssemblyError, type EvidenceInput } from "../src/evidence.js";
import { evaluate } from "../src/evaluator.js";
import { evaluatorImplementationHash } from "../src/identity.js";
import type { ForkHandle } from "../src/anvil.js";
import type { InvocationRecord } from "../src/invoke.js";
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

const AGENT_VERSION_HASH = `0x${"a".repeat(64)}` as Hex;
const REFERENCE_HASH = `0x${"b".repeat(64)}` as Hex;
const SKILL = "restore-health-factor";

const CORRECT_AMOUNT = BigInt(reference(AT_RISK).expectedAction?.amount ?? "0");

const fork = (overrides: Partial<ForkHandle> = {}): ForkHandle => ({
  endpoint: "http://127.0.0.1:8545",
  port: 8545,
  blockNumber: 125_598_995n,
  blockHash: `0x${"c".repeat(64)}` as Hex,
  rpcSourceClass: "archive",
  anvilVersion: "anvil Version: 1.7.1",
  stop: async () => {},
  ...overrides,
});

const invocation = (): InvocationRecord => ({
  requestId: "7f6e5d4c-3b2a-4190-8877-665544332211",
  proposal: propose(CORRECT_AMOUNT),
  endpointHash: `0x${"d".repeat(64)}` as Hex,
  requestHash: `0x${"e".repeat(64)}` as Hex,
  responseHash: `0x${"f".repeat(64)}` as Hex,
  observationsHash: `0x${"1".repeat(64)}` as Hex,
  latencyMs: 412,
  protocol: "REFERENCE",
});

function outcomeChecks() {
  const pre = observation(AT_RISK);
  const result = evaluate({
    preState: pre,
    postState: observation({ ...AT_RISK, usdtBorrow: (AT_RISK.usdtBorrow ?? 0n) - CORRECT_AMOUNT }),
    proposal: propose(CORRECT_AMOUNT),
    reference: reference(AT_RISK),
    transactions: [transaction({ index: 0 })],
    authorisedTarget: VUSDT,
    authorisedSelector: REPAY_BORROW_SELECTOR,
    spendCapRawUnits: SPEND_CAP_RAW_UNITS,
    agentObservedBlock: pre.blockNumber,
  });
  if (result.status !== "COMPLETE") throw new Error("the fixture run must reach a verdict");
  return result;
}

function input(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  const verdict = outcomeChecks();
  return {
    category: "HEALTH_FACTOR",
    trialSpecHash: `0x${"2".repeat(64)}` as Hex,
    fork: fork(),
    chainId: 97,
    modifications: [],
    agent: {
      identityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
      agentId: "1824",
      agentVersionHash: AGENT_VERSION_HASH,
    },
    invocation: invocation(),
    preState: observation(AT_RISK),
    postState: observation({ ...AT_RISK, usdtBorrow: (AT_RISK.usdtBorrow ?? 0n) - CORRECT_AMOUNT }),
    transactions: [transaction({ index: 0 })],
    referenceImplementationHash: REFERENCE_HASH,
    referenceInputsHash: `0x${"3".repeat(64)}` as Hex,
    reference: reference(AT_RISK),
    evaluatorImplementationHash: evaluatorImplementationHash(),
    checks: verdict.checks,
    result: verdict.result,
    observedAt: 1_786_500_000,
    ...overrides,
  };
}

describe("the artifact answers a verifier's four questions", () => {
  it("carries what the chain said, before and after", () => {
    // #given an assembled artifact
    const { evidence } = assembleEvidence(input(), ACCOUNT, SKILL);

    // #then both raw readings are present, complete, and pinned to a block
    expect(evidence.observations.preState.markets.length).toBeGreaterThan(40);
    expect(evidence.observations.postState.blockNumber).toMatch(/^[0-9]+$/);
    expect(evidence.observations.preState.nonMarketDebt[0]?.symbol).toBe("VAI");
  });

  it("carries what the agent did, proposal and transactions alike", () => {
    // #given an assembled artifact
    const { evidence } = assembleEvidence(input(), ACCOUNT, SKILL);

    // #then the decision, the call and the receipt are all readable
    expect(evidence.observations.agentProposal.decision).toBe("PROPOSE");
    expect(evidence.observations.agentProposal.action?.selector).toBe(REPAY_BORROW_SELECTOR);
    expect(evidence.observations.txs[0]?.origin).toBe("AGENT_PROPOSAL");
  });

  it("carries what the independent model predicted, with its working", () => {
    // #given an assembled artifact
    const { evidence } = assembleEvidence(input(), ACCOUNT, SKILL);

    // #then the prediction and the exposures behind it are both present
    expect(evidence.reference.output.expectedAction?.amount).toBe(CORRECT_AMOUNT.toString(10));
    expect(evidence.reference.output.exposures.length).toBeGreaterThan(0);
    expect(evidence.reference.inputsHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("carries what the evaluator checked and why the verdict followed", () => {
    // #given an assembled artifact
    const { evidence } = assembleEvidence(input(), ACCOUNT, SKILL);

    // #then every check is listed, including the ones that passed
    expect(evidence.evaluator.result).toBe("PASS");
    expect(evidence.evaluator.checks.length).toBeGreaterThanOrEqual(10);
    expect(evidence.evaluator.implementationHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("fail-closed refinements", () => {
  it("refuses a PASS that contains a failed check", () => {
    // #given a verdict of PASS over a check that failed
    const verdict = outcomeChecks();
    const tampered = input({
      checks: [...verdict.checks.slice(1), { checkId: "action-target-authorised", description: "x", status: "FAIL", expected: "a", observed: "b" }],
      result: "PASS",
    });

    // #then assembly refuses rather than publishing the contradiction
    expect(() => assembleEvidence(tampered, ACCOUNT, SKILL)).toThrow(EvidenceAssemblyError);
  });

  it("refuses a FAIL that names no failed check", () => {
    // #given a verdict of FAIL over checks that all passed
    expect(() =>
      assembleEvidence(input({ result: "FAIL", failureReason: "something" }), ACCOUNT, SKILL),
    ).toThrow(EvidenceAssemblyError);
  });

  it("refuses a FAIL that states no reason", () => {
    // #given a genuine failure with the reason stripped
    const verdict = outcomeChecks();
    const failing = input({
      checks: [
        { checkId: "action-target-authorised", description: "target", status: "FAIL", expected: "a", observed: "b" },
        ...verdict.checks.slice(1),
      ],
      result: "FAIL",
    });

    // #then the artifact is rejected. A failure with no stated reason is a
    // rating, and MANDATE publishes reasons rather than ratings.
    expect(() => assembleEvidence(failing, ACCOUNT, SKILL)).toThrow(EvidenceAssemblyError);
  });

  it("requires a modified environment to carry its label", () => {
    // #given a modification list with an unlabelled entry
    const unlabelled = [
      { label: "", kind: "SET_STORAGE", target: VUSDT, rpcMethod: "anvil_setStorageAt", detail: "slot 3" },
    ] as unknown as StateModification[];

    // #then assembly refuses. An unlabelled state write is indistinguishable
    // from a real chain reading to anyone reading the artifact.
    expect(() => assembleEvidence(input({ modifications: unlabelled }), ACCOUNT, SKILL)).toThrow(
      EvidenceAssemblyError,
    );
  });

  it("records a modified environment as modified", () => {
    // #given a labelled oracle shock
    const shock: StateModification[] = [
      {
        label: "SIMULATED ORACLE SHOCK",
        kind: "SET_ORACLE_PRICE",
        target: "0x3cd69251d04a28d887ac14cbe2e14c52f3d57823",
        rpcMethod: "anvil_setStorageAt",
        detail: "slot 0x04 written to 250000000000000000000000000000",
      },
    ];
    const { evidence } = assembleEvidence(input({ modifications: shock }), ACCOUNT, SKILL);

    // #then the flag and the label travel together, so a reader cannot see the
    // result without seeing that the price was not the oracle's
    expect(evidence.environment.modifiedState).toBe(true);
    expect(evidence.environment.modifications[0]?.label).toBe("SIMULATED ORACLE SHOCK");
    expect(evidence.environment.modifications[0]?.rpcMethod).toBe("anvil_setStorageAt");
  });

  it("requires a head-pinned fork to state why archive state was unavailable", () => {
    // #given a live-sourced fork with no reason recorded
    const dishonest = input({
      fork: fork({ rpcSourceClass: "live" }),
    });

    // #then the artifact is rejected. `live` has to be a disclosure, not a
    // field value a reader skims past.
    expect(() => assembleEvidence(dishonest, ACCOUNT, SKILL)).toThrow(EvidenceAssemblyError);
  });

  it("records a head-pinned run honestly rather than claiming archive state", () => {
    // #given a fork that degraded because the RPC had pruned the pinned block
    const degraded = input({
      fork: fork({
        rpcSourceClass: "live",
        degradedReason: "the RPC has pruned the state at block 125000000, so the fork was taken at the chain head instead",
      }),
    });
    const { evidence } = assembleEvidence(degraded, ACCOUNT, SKILL);

    // #then the artifact says so in both fields
    expect(evidence.environment.rpcSourceClass).toBe("live");
    expect(evidence.environment.rpcDegradedReason).toContain("pruned");
  });

  it("refuses an artifact whose reference model is the agent under test", () => {
    // #given a reference implementation hash equal to the agent's version hash
    const collapsed = input({ referenceImplementationHash: AGENT_VERSION_HASH });

    // #then the artifact is rejected. Two conclusions from one implementation
    // is one conclusion asserted twice.
    expect(() => assembleEvidence(collapsed, ACCOUNT, SKILL)).toThrow(EvidenceAssemblyError);
  });

  it("refuses an observation from a chain the fork was not taken from", () => {
    // #given a pre-state read on a different chain
    const crossed = input({ chainId: 56 });

    // #then the mismatch is caught rather than published
    expect(() => assembleEvidence(crossed, ACCOUNT, SKILL)).toThrow(EvidenceAssemblyError);
  });
});

describe("canonical hashing", () => {
  it("hashes to a stable value across assemblies", () => {
    // #given the same inputs assembled twice
    const first = assembleEvidence(input(), ACCOUNT, SKILL);
    const second = assembleEvidence(input(), ACCOUNT, SKILL);

    // #then the hash a receipt commits to does not move
    expect(first.evidenceHash).toBe(second.evidenceHash);
  });

  it("hashes the validated document, so a verifier reproduces it from the artifact alone", () => {
    // #given a published artifact
    const { evidence, evidenceHash } = assembleEvidence(input(), ACCOUNT, SKILL);

    // #when a verifier re-derives the hash from the document it received
    // #then it matches, without needing anything the runner kept to itself
    expect(evidenceHashOf(evidence)).toBe(evidenceHash);
    expect(canonicalHash(evidence as unknown as CanonicalValue)).toBe(evidenceHash);
  });

  it("changes when any part of the evidence changes", () => {
    // #given two artifacts differing only in the agent's proposed amount
    const baseline = assembleEvidence(input(), ACCOUNT, SKILL);
    const altered = assembleEvidence(
      input({
        invocation: { ...invocation(), proposal: propose(CORRECT_AMOUNT + 1n) },
      }),
      ACCOUNT,
      SKILL,
    );

    // #then the commitment distinguishes them
    expect(altered.evidenceHash).not.toBe(baseline.evidenceHash);
  });

  it("round-trips through the schema a verifier would use", () => {
    // #given a published artifact re-read as JSON
    const { evidence } = assembleEvidence(input(), ACCOUNT, SKILL);
    const wire = JSON.parse(JSON.stringify(evidence)) as unknown;

    // #then it validates, so the document on the wire is the document that was hashed
    expect(TrialEvidenceSchema.safeParse(wire).success).toBe(true);
  });
});

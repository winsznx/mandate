import { describe, expect, it } from "vitest";
import {
  AuthorityIRSchema,
  CompiledMandateSchema,
  EvidenceArtifactSchema,
  ProtocolSafetyProfileSchema,
  TrialReceiptSchema,
  TrialSpecSchema,
} from "../src/schemas/index.js";
import {
  GOLDEN_GRANTED_AUTHORITY,
  GOLDEN_TESTED_AUTHORITY,
  GOLDEN_TRIAL_RECEIPT,
  GOLDEN_TRIAL_SPEC,
} from "../src/fixtures.js";

describe("AuthorityIRSchema", () => {
  it("accepts the golden tested authority", () => {
    expect(AuthorityIRSchema.safeParse(GOLDEN_TESTED_AUTHORITY).success).toBe(true);
  });

  it("accepts the golden granted authority", () => {
    expect(AuthorityIRSchema.safeParse(GOLDEN_GRANTED_AUTHORITY).success).toBe(true);
  });

  it("lowercases a checksummed address so casing cannot change a hash", () => {
    // #given an authority whose target is checksum-cased
    const input = {
      ...GOLDEN_TESTED_AUTHORITY,
      calls: [{ ...GOLDEN_TESTED_AUTHORITY.calls[0]!, target: "0xEeEeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" }],
    };

    // #when parsed
    const parsed = AuthorityIRSchema.parse(input);

    // #then the stored form is lowercase
    expect(parsed.calls[0]!.target).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  });

  it("rejects an authority with no permitted calls, which would be meaningless", () => {
    expect(AuthorityIRSchema.safeParse({ ...GOLDEN_TESTED_AUTHORITY, calls: [] }).success).toBe(
      false,
    );
  });

  it("rejects a spend limit expressed as a number rather than a decimal string", () => {
    // #given a limit large enough to lose precision as a JSON number
    const input = {
      ...GOLDEN_TESTED_AUTHORITY,
      spend: [{ token: GOLDEN_TESTED_AUTHORITY.spend[0]!.token, limit: 25e18, period: "day" }],
    };

    // #when parsed
    // #then it is refused
    expect(AuthorityIRSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a decimal string with a leading zero, which has two spellings", () => {
    const input = {
      ...GOLDEN_TESTED_AUTHORITY,
      spend: [{ token: GOLDEN_TESTED_AUTHORITY.spend[0]!.token, limit: "0025", period: "day" }],
    };
    expect(AuthorityIRSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an unknown field rather than silently dropping it", () => {
    // #given a document carrying a constraint this version does not understand
    const input = { ...GOLDEN_TESTED_AUTHORITY, maxCallsPerHour: 3 };

    // #when parsed
    // #then it fails, because ignoring it would understate the authority
    expect(AuthorityIRSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a lifetime longer than a year", () => {
    const input = { ...GOLDEN_TESTED_AUTHORITY, lifetime: { maxDurationSeconds: 40_000_000 } };
    expect(AuthorityIRSchema.safeParse(input).success).toBe(false);
  });
});

describe("TrialSpecSchema", () => {
  it("accepts the golden spec", () => {
    expect(TrialSpecSchema.safeParse(GOLDEN_TRIAL_SPEC).success).toBe(true);
  });

  it("rejects a spec whose authority targets a different chain", () => {
    // #given an authority on chain 56 inside a spec pinned to chain 97
    const input = {
      ...GOLDEN_TRIAL_SPEC,
      authority: { ...GOLDEN_TESTED_AUTHORITY, chainId: 56 },
    };

    // #when parsed
    // #then the mismatch is caught
    expect(TrialSpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a spec that expires before it was created", () => {
    const input = {
      ...GOLDEN_TRIAL_SPEC,
      timing: { ...GOLDEN_TRIAL_SPEC.timing, expiresAt: GOLDEN_TRIAL_SPEC.timing.createdAt - 1 },
    };
    expect(TrialSpecSchema.safeParse(input).success).toBe(false);
  });
});

describe("TrialReceiptSchema", () => {
  it("accepts the golden receipt", () => {
    expect(TrialReceiptSchema.safeParse(GOLDEN_TRIAL_RECEIPT).success).toBe(true);
  });

  it("rejects a receipt that is stale the moment it is written", () => {
    const input = { ...GOLDEN_TRIAL_RECEIPT, freshUntil: GOLDEN_TRIAL_RECEIPT.createdAt };
    expect(TrialReceiptSchema.safeParse(input).success).toBe(false);
  });

  it("admits only PASS and FAIL, never ERROR", () => {
    // #given an infrastructure failure being passed off as a result
    const input = { ...GOLDEN_TRIAL_RECEIPT, result: "ERROR" };

    // #when parsed
    // #then it is refused, so a crash never reaches an agent's record
    expect(TrialReceiptSchema.safeParse(input).success).toBe(false);
  });
});

describe("ProtocolSafetyProfileSchema", () => {
  const base = {
    schemaVersion: "mandate.protocol-safety-profile/1",
    profileId: "venus-vusdt-repayborrow",
    chainId: 97,
    protocolId: "venus",
    target: "0x2222222222222222222222222222222222222222",
    selector: "0x0e752702",
    signature: "repayBorrow(uint256)",
    runtimeCodeHash: `0x${"b".repeat(64)}`,
    proxyType: "NONE" as const,
    upgradeable: false,
    arbitraryRecipient: false,
    arbitraryAsset: false,
    arbitraryDownstreamTarget: false,
    delegateCallReachable: false,
    multicallReachable: false,
    createsPersistentApproval: true,
    callbackReachable: false,
    verdict: "DIRECT_SAFE" as const,
    supportedConstraints: ["target", "selector", "spend-cap", "expiry"],
    unresolvedRisks: [],
    analyzedAtBlock: "40000000",
    analyzedAt: 1_790_000_000,
    analyzerVersion: "1.0.0",
  };

  it("accepts a fully bounded direct-safe profile", () => {
    expect(ProtocolSafetyProfileSchema.safeParse(base).success).toBe(true);
  });

  it("refuses DIRECT_SAFE while a risk is unresolved", () => {
    // #given an analysis that could not settle one question
    const input = { ...base, unresolvedRisks: ["recipient control unproven"] };

    // #when parsed
    // #then the optimistic verdict is rejected
    expect(ProtocolSafetyProfileSchema.safeParse(input).success).toBe(false);
  });

  it("refuses DIRECT_SAFE when the call can reach an arbitrary recipient", () => {
    // #given a call whose calldata names where assets go
    const input = { ...base, arbitraryRecipient: true };

    // #when parsed
    // #then target-and-selector restrictions are not accepted as sufficient
    expect(ProtocolSafetyProfileSchema.safeParse(input).success).toBe(false);
  });

  it("refuses DIRECT_SAFE when a multicall is reachable", () => {
    expect(ProtocolSafetyProfileSchema.safeParse({ ...base, multicallReachable: true }).success).toBe(
      false,
    );
  });

  it("allows the same reachability once the verdict is GUARD_REQUIRED", () => {
    // #given an arbitrary recipient routed through a typed guard instead
    const input = { ...base, arbitraryRecipient: true, verdict: "GUARD_REQUIRED" as const };

    // #when parsed
    // #then it is accepted
    expect(ProtocolSafetyProfileSchema.safeParse(input).success).toBe(true);
  });

  it("requires a proxy profile to record its implementation", () => {
    const input = { ...base, proxyType: "EIP1967" as const, upgradeable: true };
    expect(ProtocolSafetyProfileSchema.safeParse(input).success).toBe(false);
  });
});

describe("EvidenceArtifactSchema", () => {
  const base = {
    schemaVersion: "mandate.evidence/1",
    trialSpecHash: `0x${"d".repeat(64)}`,
    category: "HEALTH_FACTOR" as const,
    provenance: "Trial-verified" as const,
    environment: {
      chainId: 97,
      forkBlock: "40000000",
      stateModified: false,
      runnerVersion: "1.0.0",
      anvilVersion: "1.7.1",
    },
    invocation: {
      protocol: "A2A" as const,
      endpointHash: `0x${"3".repeat(64)}`,
      requestHash: `0x${"4".repeat(64)}`,
      responseHash: `0x${"5".repeat(64)}`,
      latencyMs: 412,
      outcome: "OK" as const,
    },
    preState: [],
    trace: [],
    postState: [],
    referenceOutcome: { modelId: "hf-reference", modelVersion: "1.0.0", expected: [], notes: [] },
    checks: [{ checkId: "hf-restored", description: "health factor at or above target", passed: true }],
    result: "PASS" as const,
    observedAt: 1_790_000_000,
  };

  it("accepts a passing artifact whose checks all passed", () => {
    expect(EvidenceArtifactSchema.safeParse(base).success).toBe(true);
  });

  it("refuses a PASS that contains a failed check", () => {
    // #given an evaluator recording a failure alongside a pass verdict
    const input = {
      ...base,
      checks: [{ checkId: "hf-restored", description: "restored", passed: false }],
    };

    // #when parsed
    // #then the contradiction is rejected
    expect(EvidenceArtifactSchema.safeParse(input).success).toBe(false);
  });

  it("requires a FAIL to state its reason", () => {
    const input = {
      ...base,
      result: "FAIL" as const,
      checks: [{ checkId: "hf-restored", description: "restored", passed: false }],
    };
    expect(EvidenceArtifactSchema.safeParse(input).success).toBe(false);
  });

  it("requires a modified environment to be labelled", () => {
    // #given a scenario that moved an oracle price
    const input = { ...base, environment: { ...base.environment, stateModified: true } };

    // #when parsed
    // #then it cannot be published without saying so
    expect(EvidenceArtifactSchema.safeParse(input).success).toBe(false);
  });

  it("accepts a modified environment carrying its label", () => {
    const input = {
      ...base,
      environment: {
        ...base.environment,
        stateModified: true,
        modificationLabel: "SIMULATED ORACLE SHOCK",
      },
    };
    expect(EvidenceArtifactSchema.safeParse(input).success).toBe(true);
  });
});

describe("CompiledMandateSchema", () => {
  it("refuses a mandate whose subset proof did not pass", () => {
    // #given a compilation that produced a failing proof
    const input = {
      schemaVersion: "mandate.compiled-mandate/1",
      testedAuthorityHash: `0x${"e".repeat(64)}`,
      grantedAuthorityHash: `0x${"f".repeat(64)}`,
      grantedAuthority: GOLDEN_GRANTED_AUTHORITY,
      enforcement: {
        layer: "altana",
        layerVersion: "0.7.1",
        permissionsHash: `0x${"1".repeat(64)}`,
        expiry: 1_800_000_000,
      },
      durableEffects: { approvals: [], signatureCheckers: [], other: [] },
      warnings: [],
      proof: {
        subset: false,
        comparatorVersion: "1.0.0",
        comparatorHash: `0x${"2".repeat(64)}`,
        violations: ["spend limit exceeds tested"],
      },
    };

    // #when parsed
    // #then no mandate document can exist
    expect(CompiledMandateSchema.safeParse(input).success).toBe(false);
  });
});

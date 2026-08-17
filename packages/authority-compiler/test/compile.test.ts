import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import type { AuthorityIR, ProtocolSafetyProfile } from "@mandate/domain";
import { GOLDEN_GRANTED_AUTHORITY, GOLDEN_TESTED_AUTHORITY } from "@mandate/domain/fixtures";
import { compileAuthority, profileKey, standingAllowanceFor } from "../src/compile.js";

const VUSDT: Address = "0x2222222222222222222222222222222222222222";
const REPAY_BORROW: Hex = "0x0e752702";
const SESSION_PUBLIC_KEY: Hex = `0x04${"ab".repeat(64)}`;
const NOW = 1_790_000_000;

const DIRECT_SAFE_PROFILE: ProtocolSafetyProfile = {
  schemaVersion: "mandate.protocol-safety-profile/1",
  profileId: "venus-vusdt-repayborrow",
  chainId: 97,
  protocolId: "venus",
  target: VUSDT,
  selector: REPAY_BORROW,
  signature: "repayBorrow(uint256)",
  runtimeCodeHash: `0x${"b".repeat(64)}`,
  proxyType: "DELEGATOR",
  implementation: "0x7777777777777777777777777777777777777777",
  implementationCodeHash: `0x${"b".repeat(64)}`,
  upgradeable: true,
  upgradeAdmin: "0x9393939393939393939393939393939393939393",
  arbitraryRecipient: false,
  arbitraryAsset: false,
  arbitraryDownstreamTarget: false,
  delegateCallReachable: false,
  multicallReachable: false,
  createsPersistentApproval: true,
  callbackReachable: false,
  verdict: "DIRECT_SAFE",
  supportedConstraints: ["target", "selector", "spend-cap", "expiry"],
  unresolvedRisks: [],
  analyzedAtBlock: "40000000",
  analyzedAt: NOW - 100,
  analyzerVersion: "1.0.0",
};

function profiles(
  overrides: Partial<ProtocolSafetyProfile> = {},
): ReadonlyMap<string, ProtocolSafetyProfile> {
  return new Map([
    [profileKey(VUSDT, REPAY_BORROW), { ...DIRECT_SAFE_PROFILE, ...overrides }],
  ]);
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    tested: GOLDEN_TESTED_AUTHORITY,
    granted: GOLDEN_GRANTED_AUTHORITY,
    profiles: profiles(),
    evidenceIsCurrent: true,
    expiry: NOW + 3_600,
    now: NOW,
    sessionPublicKey: SESSION_PUBLIC_KEY,
    ...overrides,
  } as Parameters<typeof compileAuthority>[0];
}

function errorCodes(result: ReturnType<typeof compileAuthority>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

describe("compileAuthority — the happy path", () => {
  it("compiles a grant that is within scope and fully profiled", () => {
    // #given a narrower grant against a DIRECT_SAFE call
    // #when compiled
    const result = compileAuthority(input());

    // #then a mandate is produced carrying a passing subset proof
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mandate.proof.subset).toBe(true);
    expect(result.mandate.proof.violations).toEqual([]);
  });

  it("commits to both the tested and granted authority hashes", () => {
    const result = compileAuthority(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mandate.testedAuthorityHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.mandate.grantedAuthorityHash).not.toBe(result.mandate.testedAuthorityHash);
  });

  it("warns that an upgradeable target can stop matching its profile", () => {
    // #given Venus behind an upgradeable delegator
    const result = compileAuthority(input());

    // #then the user is told who can change it
    expect(result.warnings.some((warning) => warning.code === "UPGRADEABLE_TARGET")).toBe(true);
  });
});

describe("compileAuthority — refusals", () => {
  it("refuses a grant that exceeds the tested spend", () => {
    // #given a grant asking for more than the trial certified
    const granted: AuthorityIR = {
      ...GOLDEN_GRANTED_AUTHORITY,
      spend: [{ ...GOLDEN_GRANTED_AUTHORITY.spend[0]!, limit: "999000000000000000000" }],
    };

    // #when compiled
    const result = compileAuthority(input({ granted }));

    // #then no mandate is produced at all
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("NOT_A_SUBSET");
  });

  it("refuses a call that has no safety profile", () => {
    // #given a permitted call whose real reach has never been analysed
    const result = compileAuthority(input({ profiles: new Map() }));

    // #then it is refused rather than assumed safe
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("MISSING_PROTOCOL_PROFILE");
  });

  /**
   * The refusal that keeps the product honest. A GUARD_REQUIRED call carries
   * authority in its calldata — an arbitrary recipient, say — that
   * target-and-selector restrictions cannot bound. Emitting a session anyway
   * would display a narrow scope over a wide one.
   */
  it("refuses a GUARD_REQUIRED call when no guard is configured", () => {
    // #given a call whose calldata carries authority, and no guard
    const result = compileAuthority(input({ profiles: profiles({ verdict: "GUARD_REQUIRED" }) }));

    // #then compilation fails closed
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("UNSUPPORTED_AUTHORITY");
  });

  it("refuses an UNSUPPORTED call outright", () => {
    const result = compileAuthority(input({ profiles: profiles({ verdict: "UNSUPPORTED" }) }));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("UNSUPPORTED_AUTHORITY");
  });

  it("refuses semantic constraints that nothing configured can enforce", () => {
    // #given a grant restricting recipients, with no guard to apply it
    const granted: AuthorityIR = {
      ...GOLDEN_GRANTED_AUTHORITY,
      calls: [
        {
          ...GOLDEN_GRANTED_AUTHORITY.calls[0]!,
          semanticConstraints: { allowedRecipients: ["0x4444444444444444444444444444444444444444"] },
        },
      ],
    };

    // #when compiled
    const result = compileAuthority(input({ granted }));

    // #then it is refused, because the wallet layer has no calldata predicates
    // and silently dropping the constraint would leave the user reading a
    // boundary nothing enforces
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("UNSUPPORTED_AUTHORITY");
  });

  it("refuses when the deployed code no longer matches the analysed version", () => {
    // #given a target that was upgraded after the authority was built
    const result = compileAuthority(
      input({ profiles: profiles({ implementationCodeHash: `0x${"c".repeat(64)}` }) }),
    );

    // #then the stale profile blocks the grant
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("PROFILE_INVALIDATED");
  });

  it("refuses when the trial evidence is no longer current", () => {
    const result = compileAuthority(input({ evidenceIsCurrent: false }));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("EVIDENCE_NOT_CURRENT");
  });

  it("refuses an expiry beyond the granted lifetime", () => {
    // #given a 24-hour grant asked to live 48 hours
    const result = compileAuthority(input({ expiry: NOW + 172_800 }));

    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("LIFETIME_EXCEEDS_TESTED");
  });

  it("refuses an expiry in the past", () => {
    const result = compileAuthority(input({ expiry: NOW - 1 }));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain("LIFETIME_EXCEEDS_TESTED");
  });

  it("reports every refusal reason rather than stopping at the first", () => {
    // #given a grant that is both stale and unprofiled
    const result = compileAuthority(input({ evidenceIsCurrent: false, profiles: new Map() }));

    // #then the user sees the full list of what a new trial must cover
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("standingAllowanceFor", () => {
  /**
   * Sizing the allowance to a single period is the intuitive reading of
   * "minimally sufficient" and it silently breaks the headline proof: a 20
   * repayment against a 25 allowance leaves 5, so the following 6 fails on the
   * ERC-20 allowance rather than on the spend cap. The demo would look correct
   * while proving a misconfiguration.
   */
  it("covers the whole mandate lifetime, not one period", () => {
    // #given a 25-per-day cap over a 7-day mandate
    const allowance = standingAllowanceFor({
      periodLimit: 25_000_000n,
      period: "day",
      lifetimeSeconds: 7 * 86_400,
    });

    // #then the allowance covers all seven days, leaving the spend cap as the
    // binding constraint
    expect(allowance).toBe(175_000_000n);
  });

  it("rounds up a partial period, which the calendar genuinely spans", () => {
    // #given a mandate lasting a day and a half
    const allowance = standingAllowanceFor({
      periodLimit: 25n,
      period: "day",
      lifetimeSeconds: 129_600,
    });

    // #then two buckets are covered, because a 36-hour window touches two
    expect(allowance).toBe(50n);
  });

  it("never returns zero for a lifetime shorter than one period", () => {
    const allowance = standingAllowanceFor({
      periodLimit: 25n,
      period: "day",
      lifetimeSeconds: 60,
    });
    expect(allowance).toBe(25n);
  });
});

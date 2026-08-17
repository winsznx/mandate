import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { decodeCanExecuteEntry, type EnforcedAuthority } from "../src/account-reads.js";
import { ANY_FN_SEL, ANY_TARGET, BSC_TESTNET } from "../src/constants.js";
import {
  diffRequestedVsEnforced,
  hasCriticalDiscrepancy,
  normalizeRequestedCall,
  reconstructAuthorityIR,
  type RequestedSessionPermissions,
} from "../src/effective-authority.js";

const WALLET: Address = "0x4444444444444444444444444444444444444444";
const VUSDT: Address = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a";
const USDT: Address = "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c";
const ORCHESTRATOR = BSC_TESTNET.orchestrator;
const REPAY_BORROW: Hex = "0x0e752702";
const KEY_HASH: Hex = `0x${"ab".repeat(32)}`;

/** Build the packed `(target, selector)` word exactly as the account stores it. */
function packed(target: Address, selector: Hex): Hex {
  return `0x${target.slice(2)}${"00".repeat(8)}${selector.slice(2)}` as Hex;
}

function enforced(overrides: Partial<EnforcedAuthority> = {}): EnforcedAuthority {
  return {
    wallet: WALLET,
    keyHash: KEY_HASH,
    registered: true,
    expiry: 1_800_000_000,
    isSuperAdmin: false,
    callRules: [decodeCanExecuteEntry(packed(VUSDT, REPAY_BORROW))],
    walletWideRules: [],
    spendLimits: [
      {
        token: USDT,
        period: "day",
        periodEnum: 2,
        limit: 25_000_000n,
        currentSpent: 0n,
        currentPeriodStart: 1_790_000_000n,
        remaining: 25_000_000n,
      },
    ],
    observedAtBlock: 40_000_000n,
    ...overrides,
  };
}

const REQUESTED: RequestedSessionPermissions = {
  calls: [{ to: VUSDT, signature: "repayBorrow(uint256)" }],
  spend: [{ token: USDT, limit: 25_000_000n, period: "day" }],
};

describe("decodeCanExecuteEntry", () => {
  it("splits the packed word into target and selector", () => {
    // #given the layout the account uses: target(20) || zeros(8) || selector(4)
    const word = packed(VUSDT, REPAY_BORROW);

    // #when decoded
    const rule = decodeCanExecuteEntry(word);

    // #then both halves come back intact
    expect(rule.target).toBe(VUSDT);
    expect(rule.selector).toBe(REPAY_BORROW);
  });

  it("recognises the wildcard target", () => {
    const rule = decodeCanExecuteEntry(packed(ANY_TARGET, REPAY_BORROW));
    expect(rule.targetIsWildcard).toBe(true);
  });

  it("recognises the wildcard selector", () => {
    const rule = decodeCanExecuteEntry(packed(VUSDT, ANY_FN_SEL));
    expect(rule.selectorIsWildcard).toBe(true);
  });

  it("keeps the raw word so evidence can quote what was read", () => {
    const word = packed(VUSDT, REPAY_BORROW);
    expect(decodeCanExecuteEntry(word).packed).toBe(word);
  });
});

describe("normalizeRequestedCall", () => {
  it("derives a selector from an ABI signature", () => {
    expect(normalizeRequestedCall({ to: VUSDT, signature: "repayBorrow(uint256)" })).toEqual({
      target: VUSDT,
      selector: REPAY_BORROW,
    });
  });

  it("accepts a raw selector, which the wallet layer also allows", () => {
    expect(normalizeRequestedCall({ to: VUSDT, signature: REPAY_BORROW }).selector).toBe(REPAY_BORROW);
  });

  it("treats an omitted signature as the wildcard selector, not as no permission", () => {
    // #given a permission naming only a target
    // #when normalised
    // #then it means every method on that target
    expect(normalizeRequestedCall({ to: VUSDT }).selector).toBe(ANY_FN_SEL);
  });

  it("treats an omitted target as the wildcard target", () => {
    expect(normalizeRequestedCall({ signature: "repayBorrow(uint256)" }).target).toBe(ANY_TARGET);
  });
});

describe("diffRequestedVsEnforced", () => {
  it("reports no discrepancy when the chain matches the request", () => {
    const discrepancies = diffRequestedVsEnforced(REQUESTED, enforced(), {
      orchestrator: ORCHESTRATOR,
    });
    expect(discrepancies).toEqual([]);
  });

  /**
   * The regression fixture for the finding that motivates this whole module.
   * Porto appends a wildcard-selector permission for the Orchestrator to every
   * session key. It is absent from the requested object, so an interface that
   * renders the request understates the session's real reach.
   */
  it("surfaces the Orchestrator permission the wallet layer adds to every session", () => {
    // #given a session that also carries the Orchestrator rule on chain
    const state = enforced({
      callRules: [
        decodeCanExecuteEntry(packed(VUSDT, REPAY_BORROW)),
        decodeCanExecuteEntry(packed(ORCHESTRATOR, ANY_FN_SEL)),
      ],
    });

    // #when compared against what MANDATE asked for
    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });

    // #then it is reported, named, and explained rather than hidden
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]!.code).toBe("UNREQUESTED_CALL_RULE");
    expect(discrepancies[0]!.target).toBe(ORCHESTRATOR);
    expect(discrepancies[0]!.message).toContain("Orchestrator");
  });

  it("treats the Orchestrator addition as disclosable rather than disqualifying", () => {
    // #given the same state
    const state = enforced({
      callRules: [
        decodeCanExecuteEntry(packed(VUSDT, REPAY_BORROW)),
        decodeCanExecuteEntry(packed(ORCHESTRATOR, ANY_FN_SEL)),
      ],
    });

    // #when severity is assessed
    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });

    // #then a mandate may still activate, because the addition is required for
    // the session to submit anything and does not widen its financial reach
    expect(hasCriticalDiscrepancy(discrepancies)).toBe(false);
  });

  it("flags an unrequested rule that is not the Orchestrator as an ordinary extra target", () => {
    const stranger: Address = "0x9999999999999999999999999999999999999999";
    const state = enforced({
      callRules: [
        decodeCanExecuteEntry(packed(VUSDT, REPAY_BORROW)),
        decodeCanExecuteEntry(packed(stranger, REPAY_BORROW)),
      ],
    });

    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });
    expect(discrepancies[0]!.message).not.toContain("Orchestrator");
    expect(discrepancies[0]!.target).toBe(stranger);
  });

  it("treats a wildcard target as critical", () => {
    // #given a rule permitting every contract on the chain
    const state = enforced({ callRules: [decodeCanExecuteEntry(packed(ANY_TARGET, REPAY_BORROW))] });

    // #when compared
    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });

    // #then no mandate may activate against it
    expect(discrepancies.some((d) => d.code === "WILDCARD_TARGET")).toBe(true);
    expect(hasCriticalDiscrepancy(discrepancies)).toBe(true);
  });

  it("treats a super-admin key as critical and stops reporting rules that never run", () => {
    // #given a key that bypasses the guard entirely
    const state = enforced({ isSuperAdmin: true });

    // #when compared
    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });

    // #then the bypass is the only thing worth saying
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0]!.code).toBe("SUPER_ADMIN_KEY");
    expect(hasCriticalDiscrepancy(discrepancies)).toBe(true);
  });

  it("treats an unregistered key as critical", () => {
    const discrepancies = diffRequestedVsEnforced(REQUESTED, enforced({ registered: false }), {
      orchestrator: ORCHESTRATOR,
    });
    expect(discrepancies[0]!.code).toBe("KEY_NOT_REGISTERED");
    expect(hasCriticalDiscrepancy(discrepancies)).toBe(true);
  });

  it("treats a wallet-wide rule as critical, since it widens every key", () => {
    // #given a rule stored under the wallet-wide key hash
    const state = enforced({
      walletWideRules: [decodeCanExecuteEntry(packed(VUSDT, "0xc5ebeaec"))],
    });

    // #when compared
    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });

    // #then it is reported even though it is absent from the session's own set
    expect(discrepancies.some((d) => d.code === "WALLET_WIDE_RULE")).toBe(true);
    expect(hasCriticalDiscrepancy(discrepancies)).toBe(true);
  });

  it("treats an enlarged spend cap as critical", () => {
    // #given the chain enforcing a higher cap than was asked for
    const state = enforced({
      spendLimits: [
        {
          token: USDT,
          period: "day",
          periodEnum: 2,
          limit: 30_000_000n,
          currentSpent: 0n,
          currentPeriodStart: 0n,
          remaining: 30_000_000n,
        },
      ],
    });

    // #when compared
    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });

    // #then the user's displayed boundary is not the real one
    expect(discrepancies[0]!.code).toBe("SPEND_LIMIT_ENLARGED");
    expect(hasCriticalDiscrepancy(discrepancies)).toBe(true);
  });

  it("reports a reduced cap without blocking activation", () => {
    const state = enforced({
      spendLimits: [
        {
          token: USDT,
          period: "day",
          periodEnum: 2,
          limit: 10_000_000n,
          currentSpent: 0n,
          currentPeriodStart: 0n,
          remaining: 10_000_000n,
        },
      ],
    });

    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });
    expect(discrepancies[0]!.code).toBe("SPEND_LIMIT_REDUCED");
    expect(hasCriticalDiscrepancy(discrepancies)).toBe(false);
  });

  it("reports a requested call the chain does not enforce", () => {
    // #given a session granted no call rules at all
    const state = enforced({ callRules: [] });

    // #when compared
    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });

    // #then the shortfall is named, since the mandate would fail mid-flight
    expect(discrepancies.some((d) => d.code === "MISSING_REQUESTED_CALL_RULE")).toBe(true);
  });

  it("reports a requested spend permission the chain does not enforce", () => {
    // #given no spend permission on chain, which forbids moving the token entirely
    const state = enforced({ spendLimits: [] });

    const discrepancies = diffRequestedVsEnforced(REQUESTED, state, { orchestrator: ORCHESTRATOR });
    expect(discrepancies.some((d) => d.code === "MISSING_REQUESTED_SPEND_LIMIT")).toBe(true);
  });

  it("reports an expiry the account did not honour", () => {
    const discrepancies = diffRequestedVsEnforced(REQUESTED, enforced(), {
      orchestrator: ORCHESTRATOR,
      requestedExpiry: 1_700_000_000,
    });
    expect(discrepancies.some((d) => d.code === "EXPIRY_MISMATCH")).toBe(true);
  });
});

describe("reconstructAuthorityIR", () => {
  const context = {
    chainId: 97,
    wallet: WALLET,
    agentIdentity: {
      identityRegistry: "0x1111111111111111111111111111111111111111" as Address,
      agentId: "18433",
    },
    agentVersionHash: `0x${"a".repeat(64)}` as Hex,
    orchestrator: ORCHESTRATOR,
    protocolIdFor: () => "venus",
  };

  it("builds an authority from chain state alone", () => {
    // #given enforced state read from the account
    // #when reconstructed
    const authority = reconstructAuthorityIR(enforced(), context, 1_790_000_000);

    // #then it describes the permitted call and cap
    expect(authority.calls).toHaveLength(1);
    expect(authority.calls[0]!.target).toBe(VUSDT);
    expect(authority.calls[0]!.selector).toBe(REPAY_BORROW);
    expect(authority.spend[0]!.limit).toBe("25000000");
    expect(authority.spend[0]!.period).toBe("day");
  });

  it("includes the Orchestrator rule rather than filtering it out", () => {
    // #given the Orchestrator permission present on chain
    const state = enforced({
      callRules: [
        decodeCanExecuteEntry(packed(VUSDT, REPAY_BORROW)),
        decodeCanExecuteEntry(packed(ORCHESTRATOR, ANY_FN_SEL)),
      ],
    });

    // #when reconstructed
    const authority = reconstructAuthorityIR(state, context, 1_790_000_000);

    // #then it appears, because the session genuinely holds it
    expect(authority.calls).toHaveLength(2);
    const orchestratorCall = authority.calls.find((call) => call.target === ORCHESTRATOR);
    expect(orchestratorCall?.protocolId).toBe("altana-orchestrator");
  });

  it("omits the selector for a wildcard rule instead of recording the sentinel", () => {
    // #given a rule permitting every method on a target
    const state = enforced({ callRules: [decodeCanExecuteEntry(packed(VUSDT, ANY_FN_SEL))] });

    // #when reconstructed
    const authority = reconstructAuthorityIR(state, context, 1_790_000_000);

    // #then the selector is absent, which the AuthorityIR reads as unrestricted.
    // Recording 0x32323232 literally would read as a narrow grant.
    expect(authority.calls[0]!.selector).toBeUndefined();
  });

  it("derives the remaining lifetime from the account's expiry", () => {
    const now = 1_790_000_000;
    const authority = reconstructAuthorityIR(enforced({ expiry: now + 3_600 }), context, now);
    expect(authority.lifetime.maxDurationSeconds).toBe(3_600);
    expect(authority.lifetime.notAfter).toBe(now + 3_600);
  });

  it("clamps an already-expired session to a non-negative lifetime", () => {
    const now = 1_790_000_000;
    const authority = reconstructAuthorityIR(enforced({ expiry: now - 100 }), context, now);
    expect(authority.lifetime.maxDurationSeconds).toBeGreaterThan(0);
    expect(authority.lifetime.notAfter).toBe(now - 100);
  });

  it("maps the zero-address token to NATIVE", () => {
    const state = enforced({
      spendLimits: [
        {
          token: "0x0000000000000000000000000000000000000000",
          period: "day",
          periodEnum: 2,
          limit: 1n,
          currentSpent: 0n,
          currentPeriodStart: 0n,
          remaining: 1n,
        },
      ],
    });
    expect(reconstructAuthorityIR(state, context, 1_790_000_000).spend[0]!.token).toBe("NATIVE");
  });
});

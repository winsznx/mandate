import { describe, expect, it } from "vitest";
import { authorityHash } from "@mandate/authority-ir";
import { isSubset } from "@mandate/authority-ir";
import {
  AT_CAP_REPAY_RAW,
  BREACH_REPAY_RAW,
  DAILY_SPEND_CAP_RAW,
  MANDATE_LIFETIME_SECONDS,
  REPAY_BORROW_SELECTOR,
  buildGrantedAuthority,
  buildTestedAuthority,
  loadVenusProfile,
  standingAllowancePlan,
} from "../src/phase7/plan.js";

const INPUTS = {
  chainId: 97,
  vToken: "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as const,
  underlying: "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c" as const,
  protocolVersionHash: `0x${"b".repeat(64)}` as const,
  agentIdentity: {
    identityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e" as const,
    agentId: "1824",
  },
  agentVersionHash: `0x${"a".repeat(64)}` as const,
};

describe("sizing the standing allowance", () => {
  it("makes the spend cap and not the allowance what rejects the breach", () => {
    // #given the lifetime-sized allowance the mandate actually creates
    const plan = standingAllowancePlan();

    // #then 20 leaves far more allowance than the 6 that must be refused, so
    // the only ceiling left to refuse it is the cumulative bucket cap
    expect(plan.standingAllowance).toBe(DAILY_SPEND_CAP_RAW * 45n);
    expect(plan.remainingAfterAtCap).toBe(plan.standingAllowance - AT_CAP_REPAY_RAW);
    expect(plan.capBindsBreach).toBe(true);
    expect(plan.headroom).toBeGreaterThan(0n);
  });

  it("catches the misconfiguration where the allowance is sized to one period", () => {
    // #given the trap `00-DECISIONS.md` §3.4 describes: approve exactly the
    // daily cap, so 20 leaves 5 and the 6 fails on the ERC-20 allowance
    const plan = standingAllowancePlan({ lifetimeSeconds: 86_400 });

    // #then the run refuses rather than proving a misconfiguration while
    // appearing to work
    expect(plan.standingAllowance).toBe(DAILY_SPEND_CAP_RAW);
    expect(plan.remainingAfterAtCap).toBe(5_000_000n);
    expect(plan.capBindsBreach).toBe(false);
    expect(plan.headroom).toBe(5_000_000n - BREACH_REPAY_RAW);
  });

  it("keeps the two repayments cumulatively over the cap and individually under it", () => {
    // #then the second call is refused for exceeding the bucket total, not for
    // being too large on its own, which is the claim the demo makes
    expect(AT_CAP_REPAY_RAW).toBeLessThan(DAILY_SPEND_CAP_RAW);
    expect(BREACH_REPAY_RAW).toBeLessThan(DAILY_SPEND_CAP_RAW);
    expect(AT_CAP_REPAY_RAW + BREACH_REPAY_RAW).toBeGreaterThan(DAILY_SPEND_CAP_RAW);
  });
});

describe("the authority documents", () => {
  it("tests an envelope bound to an agent version rather than to a wallet", () => {
    // #given the tested envelope
    const tested = buildTestedAuthority(INPUTS);

    // #then its subject wallet is the zero address, so a second user can derive
    // their own mandate from the same receipt
    expect(tested.subject.wallet).toBe("0x0000000000000000000000000000000000000000");
    expect(tested.calls).toHaveLength(1);
    expect(tested.calls[0]?.selector).toBe(REPAY_BORROW_SELECTOR);
  });

  it("declares the native spend permission rather than letting the relay add one", () => {
    // #given the tested envelope
    const tested = buildTestedAuthority(INPUTS);

    // #then the fee token appears explicitly, so the displayed policy equals
    // the on-chain policy instead of being enlarged behind the user's back
    expect(tested.spend.map((limit) => limit.token)).toContain("NATIVE");
  });

  it("grants nothing wider than what was tested", () => {
    // #given a granted authority for one wallet
    const tested = buildTestedAuthority(INPUTS);
    const granted = buildGrantedAuthority({
      ...INPUTS,
      wallet: "0x4444444444444444444444444444444444444444",
      expiry: 2_000_000_000,
      standingAllowance: standingAllowancePlan().standingAllowance,
    });

    // #then the subset comparator accepts it, which is what the compiler will
    // independently insist on before emitting any permissions
    expect(isSubset(granted, tested).subset).toBe(true);
    expect(granted.lifetime.maxDurationSeconds).toBe(MANDATE_LIFETIME_SECONDS);
  });

  it("declares the standing allowance as a durable effect that survives revocation", () => {
    // #given the granted authority
    const granted = buildGrantedAuthority({
      ...INPUTS,
      wallet: "0x4444444444444444444444444444444444444444",
      expiry: 2_000_000_000,
      standingAllowance: 175_000_000n,
    });
    const approval = granted.durableEffects.approvals[0];

    // #then the one lasting effect the mandate creates is disclosed, including
    // that revoking the session does not remove it
    expect(approval?.createdBy).toBe("ADMIN");
    expect(approval?.expiresWithSession).toBe(false);
    expect(approval?.cleanupRequired).toBe(true);
    expect(approval?.maxAmount).toBe("175000000");
  });

  it("hashes identically for identical inputs", () => {
    // #then the document a receipt commits to cannot drift between the run that
    // published it and the run that reads it back
    expect(authorityHash(buildTestedAuthority(INPUTS))).toBe(
      authorityHash(buildTestedAuthority(INPUTS)),
    );
  });
});

describe("the audited safety profile", () => {
  it("loads the committed analysis for the one permitted call", () => {
    // #given the profile artifact for chain 97
    const profile = loadVenusProfile(97);

    // #then it names the target, the selector and the verdict the authority
    // rests on, read from the analysis rather than recomputed today
    expect(profile.target).toBe(INPUTS.vToken);
    expect(profile.selector).toBe(REPAY_BORROW_SELECTOR);
    expect(profile.verdict).toBe("DIRECT_SAFE");
    expect(profile.createsPersistentApproval).toBe(true);
  });
});

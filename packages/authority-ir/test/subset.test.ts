import { describe, expect, it } from "vitest";
import type { AuthorityIR, SpendLimit } from "@mandate/domain";
import { GOLDEN_GRANTED_AUTHORITY, GOLDEN_TESTED_AUTHORITY } from "@mandate/domain/fixtures";
import { authorityHash, canonicalizeAuthority } from "../src/canonicalize.js";
import { COMPARATOR_RULES_HASH, isSubset } from "../src/subset.js";

const TESTED = GOLDEN_TESTED_AUTHORITY;
const USDT = "0x3333333333333333333333333333333333333333" as const;
const VUSDT = "0x2222222222222222222222222222222222222222" as const;

function withSpend(authority: AuthorityIR, spend: SpendLimit[]): AuthorityIR {
  return { ...authority, spend };
}

function rules(result: ReturnType<typeof isSubset>): string[] {
  return result.violations.map((violation) => violation.rule);
}

describe("isSubset — algebraic properties", () => {
  it("is reflexive: an authority is within itself", () => {
    // #given any authority
    // #when compared against itself
    const result = isSubset(TESTED, TESTED);

    // #then the relation holds
    expect(result.subset).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("holds for the golden grant, which only tightens", () => {
    // #given a grant with half the spend and a shorter lifetime
    // #when compared against what was tested
    const result = isSubset(GOLDEN_GRANTED_AUTHORITY, TESTED);

    // #then it is within scope
    expect(result.subset).toBe(true);
  });

  it("is unaffected by the order fields were written in", () => {
    // #given the same authority with its call and spend lists reversed
    const shuffled: AuthorityIR = {
      ...TESTED,
      calls: [...TESTED.calls].reverse(),
      spend: [...TESTED.spend].reverse(),
    };

    // #when hashed and compared
    // #then both the hash and the verdict are unchanged
    expect(authorityHash(shuffled)).toBe(authorityHash(TESTED));
    expect(isSubset(shuffled, TESTED).subset).toBe(true);
  });

  it("ignores the subject wallet, since a tested envelope belongs to an agent version", () => {
    // #given a grant bound to a user wallet against a wallet-independent tested envelope
    // #when compared
    // #then the differing wallet is not a violation
    expect(isSubset(GOLDEN_GRANTED_AUTHORITY, TESTED).subset).toBe(true);
    expect(GOLDEN_GRANTED_AUTHORITY.subject.wallet).not.toBe(TESTED.subject.wallet);
  });

  it("reports the comparator rules hash so a verifier can recompute the verdict", () => {
    expect(isSubset(TESTED, TESTED).comparatorHash).toBe(COMPARATOR_RULES_HASH);
    expect(COMPARATOR_RULES_HASH).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("isSubset — widening the call surface", () => {
  it("rejects a target that was never tested", () => {
    // #given a grant adding a second contract
    const granted: AuthorityIR = {
      ...TESTED,
      calls: [
        ...TESTED.calls,
        {
          target: "0x9999999999999999999999999999999999999999",
          selector: "0xa9059cbb",
          protocolId: "erc20",
        },
      ],
    };

    // #when compared
    const result = isSubset(granted, TESTED);

    // #then the untested target is refused
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("every-granted-call-covered");
  });

  it("rejects a second selector on a tested target", () => {
    // #given a grant adding borrow() alongside the tested repayBorrow()
    const granted: AuthorityIR = {
      ...TESTED,
      calls: [...TESTED.calls, { target: VUSDT, selector: "0xc5ebeaec", protocolId: "venus" }],
    };

    // #when compared
    const result = isSubset(granted, TESTED);

    // #then only the tested selector is permitted
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("granted-selector-no-wider-than-tested");
  });

  it("rejects dropping the selector, which would permit every method on the target", () => {
    // #given a grant that names the target but no selector
    const granted: AuthorityIR = {
      ...TESTED,
      calls: [{ target: VUSDT, protocolId: "venus" }],
    };

    // #when compared
    const result = isSubset(granted, TESTED);

    // #then the widening is caught, because absent means broad
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("granted-selector-no-wider-than-tested");
  });

  it("accepts adding a selector when the trial tested the whole target", () => {
    // #given a tested authority with no selector restriction
    const tested: AuthorityIR = { ...TESTED, calls: [{ target: VUSDT, protocolId: "venus" }] };

    // #when a grant narrows it to one selector
    const result = isSubset(TESTED, tested);

    // #then narrowing is allowed
    expect(result.subset).toBe(true);
  });

  it("accepts omitting a tested call entirely", () => {
    // #given a tested authority permitting two calls
    const tested: AuthorityIR = {
      ...TESTED,
      calls: [...TESTED.calls, { target: VUSDT, selector: "0xc5ebeaec", protocolId: "venus" }],
    };

    // #when only one is granted
    // #then the grant is narrower and valid
    expect(isSubset(TESTED, tested).subset).toBe(true);
  });
});

describe("isSubset — spend limits", () => {
  const testedSpend: SpendLimit = { token: USDT, limit: "50", period: "day" };
  const tested = withSpend(TESTED, [testedSpend]);

  it.each([
    ["zero", "0"],
    ["one base unit", "1"],
    ["one below the cap", "49"],
    ["exactly the cap", "50"],
  ])("accepts a granted limit of %s", (_label, limit) => {
    // #given a granted limit at or below the tested cap
    const granted = withSpend(TESTED, [{ token: USDT, limit, period: "day" }]);

    // #when compared
    // #then it is within scope
    expect(isSubset(granted, tested).subset).toBe(true);
  });

  it("rejects a granted limit one base unit above the cap", () => {
    // #given a limit of cap + 1
    const granted = withSpend(TESTED, [{ token: USDT, limit: "51", period: "day" }]);

    // #when compared
    const result = isSubset(granted, tested);

    // #then the boundary holds
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("granted-spend-limit-not-greater");
  });

  it("compares limits as integers, not as strings", () => {
    // #given "9" and "100", where string ordering would give the wrong answer
    const wide = withSpend(TESTED, [{ token: USDT, limit: "100", period: "day" }]);
    const narrow = withSpend(TESTED, [{ token: USDT, limit: "9", period: "day" }]);

    // #when compared in both directions
    // #then integer ordering decides
    expect(isSubset(narrow, wide).subset).toBe(true);
    expect(isSubset(wide, narrow).subset).toBe(false);
  });

  it("handles limits beyond the safe-integer range", () => {
    // #given caps that would lose precision as JSON numbers
    const wide = withSpend(TESTED, [
      { token: USDT, limit: "100000000000000000000000000", period: "day" },
    ]);
    const narrow = withSpend(TESTED, [
      { token: USDT, limit: "99999999999999999999999999", period: "day" },
    ]);

    // #when compared
    // #then the one-unit difference is still detected
    expect(isSubset(narrow, wide).subset).toBe(true);
    expect(isSubset(wide, narrow).subset).toBe(false);
  });

  it("rejects a shorter period at the same limit, which raises the real rate", () => {
    // #given 50/hour compared against a tested 50/day
    const granted = withSpend(TESTED, [{ token: USDT, limit: "50", period: "hour" }]);

    // #when compared
    const result = isSubset(granted, tested);

    // #then it is refused, because 50/hour permits 1200 a day
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("granted-spend-period-not-shorter");
  });

  it("accepts a longer period at the same limit", () => {
    // #given 50/week against a tested 50/day
    const granted = withSpend(TESTED, [{ token: USDT, limit: "50", period: "week" }]);

    // #when compared
    // #then it is tighter and accepted
    expect(isSubset(granted, tested).subset).toBe(true);
  });

  it("rejects a bigger burst hidden behind a longer window", () => {
    // #given 100/week, whose average rate is lower than 50/day but whose burst is not
    const granted = withSpend(TESTED, [{ token: USDT, limit: "100", period: "week" }]);

    // #when compared
    const result = isSubset(granted, tested);

    // #then the burst is what decides, so it is refused
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("granted-spend-limit-not-greater");
  });

  it("rejects a month grant against a week trial, which calendar buckets do not nest", () => {
    // #given a trial that capped 100 per calendar week
    const testedWeekly = withSpend(TESTED, [{ token: USDT, limit: "100", period: "week" }]);

    // #when a grant asks for the same 100 per calendar month
    const granted = withSpend(TESTED, [{ token: USDT, limit: "100", period: "month" }]);
    const result = isSubset(granted, testedWeekly);

    // #then it is refused: a week straddling the 1st touches two month buckets,
    // so the grant could spend 200 inside a single tested week even though a
    // month is the longer period
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("granted-spend-period-not-shorter");
  });

  it("accepts a week grant against a day trial, which do nest", () => {
    // #given a trial that capped 50 per calendar day
    const testedDaily = withSpend(TESTED, [{ token: USDT, limit: "50", period: "day" }]);

    // #when a grant asks for 50 per calendar week
    const granted = withSpend(TESTED, [{ token: USDT, limit: "50", period: "week" }]);

    // #then it is accepted, because every day sits inside exactly one week
    expect(isSubset(granted, testedDaily).subset).toBe(true);
  });

  it("accepts a year grant against a month trial", () => {
    const testedMonthly = withSpend(TESTED, [{ token: USDT, limit: "50", period: "month" }]);
    const granted = withSpend(TESTED, [{ token: USDT, limit: "50", period: "year" }]);
    expect(isSubset(granted, testedMonthly).subset).toBe(true);
  });

  it("rejects a week grant against a month trial in the other direction too", () => {
    // #given the incomparable pair reversed
    const testedMonthly = withSpend(TESTED, [{ token: USDT, limit: "100", period: "month" }]);
    const granted = withSpend(TESTED, [{ token: USDT, limit: "100", period: "week" }]);

    // #then it is still refused, since 100 per week permits far more per month
    expect(isSubset(granted, testedMonthly).subset).toBe(false);
  });

  it("rejects spending a token the trial never covered", () => {
    // #given a grant for a different token
    const granted = withSpend(TESTED, [
      { token: "0x8888888888888888888888888888888888888888", limit: "1", period: "day" },
    ]);

    // #when compared
    const result = isSubset(granted, tested);

    // #then it is refused
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("every-granted-spend-covered");
  });

  it("treats an empty spend list as spending nothing, not as unlimited", () => {
    // #given a grant with no spend entries
    const granted = withSpend(TESTED, []);

    // #when compared
    // #then it is the tightest possible grant
    expect(isSubset(granted, tested).subset).toBe(true);
  });

  it("rejects any spend when the trial tested none", () => {
    // #given a trial that permitted no spending at all
    const testedNoSpend = withSpend(TESTED, []);
    const granted = withSpend(TESTED, [{ token: USDT, limit: "1", period: "day" }]);

    // #when compared
    // #then even one base unit is outside scope
    expect(isSubset(granted, testedNoSpend).subset).toBe(false);
  });

  it("checks each token independently when several are tested", () => {
    // #given two tested tokens
    const other = "0x8888888888888888888888888888888888888888" as const;
    const multi = withSpend(TESTED, [
      { token: USDT, limit: "50", period: "day" },
      { token: other, limit: "10", period: "day" },
    ]);

    // #when one token is granted within scope and the other above it
    const granted = withSpend(TESTED, [
      { token: USDT, limit: "50", period: "day" },
      { token: other, limit: "11", period: "day" },
    ]);

    // #then only the offending token is reported, indexed against the canonical
    // (token-sorted) ordering rather than the order the caller wrote
    const result = isSubset(granted, multi);
    expect(result.subset).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.path).toBe("spend[1]");
    expect(result.violations[0]!.message).toContain(other);
  });
});

describe("isSubset — lifetime", () => {
  it("accepts a shorter lifetime", () => {
    const granted: AuthorityIR = { ...TESTED, lifetime: { maxDurationSeconds: 3_600 } };
    expect(isSubset(granted, TESTED).subset).toBe(true);
  });

  it("accepts an equal lifetime", () => {
    const granted: AuthorityIR = { ...TESTED, lifetime: { maxDurationSeconds: 604_800 } };
    expect(isSubset(granted, TESTED).subset).toBe(true);
  });

  it("rejects a lifetime one second beyond the tested bound", () => {
    // #given a grant asking for one more second than the trial certified
    const granted: AuthorityIR = { ...TESTED, lifetime: { maxDurationSeconds: 604_801 } };

    // #when compared
    const result = isSubset(granted, TESTED);

    // #then it is refused
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("granted-lifetime-not-longer");
  });
});

describe("isSubset — identity binding", () => {
  it("rejects a grant naming a different agent", () => {
    const granted: AuthorityIR = {
      ...TESTED,
      subject: {
        ...TESTED.subject,
        agentIdentity: { ...TESTED.subject.agentIdentity, agentId: "18434" },
      },
    };
    const result = isSubset(granted, TESTED);
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("agent-identity-equal");
  });

  it("rejects a grant naming a different agent version", () => {
    // #given the same ERC-8004 id behind a rebuilt agent
    const granted: AuthorityIR = {
      ...TESTED,
      subject: { ...TESTED.subject, agentVersionHash: `0x${"7".repeat(64)}` },
    };

    // #when compared
    const result = isSubset(granted, TESTED);

    // #then the new build cannot inherit the old evidence
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("agent-version-equal");
  });

  it("rejects a grant on a different chain", () => {
    const granted: AuthorityIR = { ...TESTED, chainId: 56 };
    const result = isSubset(granted, TESTED);
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("chain-id-equal");
  });
});

describe("isSubset — downstream reach and durable effects", () => {
  it("rejects enabling a downstream capability the trial did not test", () => {
    // #given a grant that permits reaching a multicall
    const granted: AuthorityIR = {
      ...TESTED,
      downstreamPolicy: { ...TESTED.downstreamPolicy, multicallReachable: true },
    };

    // #when compared
    const result = isSubset(granted, TESTED);

    // #then it is refused
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("granted-downstream-flags-not-enabled");
  });

  it("accepts disabling a capability the trial did test", () => {
    const tested: AuthorityIR = {
      ...TESTED,
      downstreamPolicy: { ...TESTED.downstreamPolicy, multicallReachable: true },
    };
    expect(isSubset(TESTED, tested).subset).toBe(true);
  });

  it("rejects an allowance larger than the one tested", () => {
    // #given a trial that tested a 100-unit allowance
    const tested: AuthorityIR = {
      ...TESTED,
      durableEffects: {
        ...TESTED.durableEffects,
        approvals: [
          {
            token: USDT,
            spender: VUSDT,
            maxAmount: "100",
            createdBy: "ADMIN",
            expiresWithSession: false,
            cleanupRequired: true,
          },
        ],
      },
    };

    // #when a grant asks for 101
    const granted: AuthorityIR = {
      ...tested,
      durableEffects: {
        ...tested.durableEffects,
        approvals: [{ ...tested.durableEffects.approvals[0]!, maxAmount: "101" }],
      },
    };

    // #then it is refused
    const result = isSubset(granted, tested);
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("granted-approvals-covered");
  });
});

describe("isSubset — guards", () => {
  const guard = {
    guardAddress: "0x7777777777777777777777777777777777777777" as const,
    guardCodeHash: `0x${"5".repeat(64)}` as const,
    guardVersion: "1.0.0",
  };

  it("accepts an identical guard on both sides", () => {
    const tested: AuthorityIR = { ...TESTED, guard };
    const granted: AuthorityIR = { ...TESTED, guard };
    expect(isSubset(granted, tested).subset).toBe(true);
  });

  it("rejects introducing a guard the trial did not run behind", () => {
    const granted: AuthorityIR = { ...TESTED, guard };
    const result = isSubset(granted, TESTED);
    expect(result.subset).toBe(false);
    expect(rules(result)).toContain("guard-identical");
  });

  it("rejects a guard whose code hash differs, since the deployed logic changed", () => {
    // #given a guard at the same address with different code
    const tested: AuthorityIR = { ...TESTED, guard };
    const granted: AuthorityIR = {
      ...TESTED,
      guard: { ...guard, guardCodeHash: `0x${"6".repeat(64)}` },
    };

    // #when compared
    // #then it is refused
    expect(isSubset(granted, tested).subset).toBe(false);
  });
});

describe("isSubset — semantic constraints", () => {
  const constrained: AuthorityIR = {
    ...TESTED,
    calls: [
      {
        ...TESTED.calls[0]!,
        semanticConstraints: {
          allowedRecipients: ["0x4444444444444444444444444444444444444444"],
          slippageBpsMax: 50,
          deadlineMaxSeconds: 600,
        },
      },
    ],
  };

  it("accepts a grant that narrows the recipient set", () => {
    const granted: AuthorityIR = {
      ...constrained,
      calls: [{ ...constrained.calls[0]!, semanticConstraints: { allowedRecipients: [], slippageBpsMax: 10, deadlineMaxSeconds: 60 } }],
    };
    expect(isSubset(granted, constrained).subset).toBe(true);
  });

  it("rejects a recipient outside the tested set", () => {
    const granted: AuthorityIR = {
      ...constrained,
      calls: [
        {
          ...constrained.calls[0]!,
          semanticConstraints: {
            ...constrained.calls[0]!.semanticConstraints,
            allowedRecipients: ["0x1212121212121212121212121212121212121212"],
          },
        },
      ],
    };
    expect(isSubset(granted, constrained).subset).toBe(false);
  });

  it("rejects dropping a constraint the trial applied", () => {
    // #given a grant with no semantic constraints at all
    const granted: AuthorityIR = {
      ...constrained,
      calls: [{ target: VUSDT, selector: "0x0e752702", protocolId: "venus" }],
    };

    // #when compared against a constrained trial
    const result = isSubset(granted, constrained);

    // #then every dropped dimension is reported
    expect(result.subset).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects looser slippage", () => {
    const granted: AuthorityIR = {
      ...constrained,
      calls: [
        {
          ...constrained.calls[0]!,
          semanticConstraints: { ...constrained.calls[0]!.semanticConstraints, slippageBpsMax: 51 },
        },
      ],
    };
    expect(isSubset(granted, constrained).subset).toBe(false);
  });
});

describe("canonicalizeAuthority", () => {
  it("sorts calls and spend deterministically", () => {
    // #given an authority whose lists are in arbitrary order
    const authority: AuthorityIR = {
      ...TESTED,
      calls: [
        { target: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", selector: "0x00000002", protocolId: "venus" },
        { target: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", selector: "0x00000001", protocolId: "venus" },
      ],
    };

    // #when canonicalised
    const canonical = canonicalizeAuthority(authority);

    // #then calls are ordered by target then selector
    expect(canonical.calls.map((call) => call.target)).toEqual([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("de-duplicates membership lists without changing their meaning", () => {
    const authority: AuthorityIR = {
      ...TESTED,
      calls: [{ ...TESTED.calls[0]!, semanticConstraints: { resourceIds: ["b", "a", "b"] } }],
    };
    expect(canonicalizeAuthority(authority).calls[0]!.semanticConstraints?.resourceIds).toEqual(["a", "b"]);
  });

  it("produces one hash for documents differing only in list order", () => {
    const a: AuthorityIR = { ...TESTED, calls: [...TESTED.calls] };
    const b: AuthorityIR = { ...TESTED, calls: [...TESTED.calls].reverse() };
    expect(authorityHash(a)).toBe(authorityHash(b));
  });
});

/**
 * The renderer behind the TESTED / GRANTED component.
 *
 * Two properties are worth more than the rest. A facet the trial tested and the
 * grant left out must still produce a row, because the narrowing is the finding
 * and a row list walking only the grant would drop it. And the spend row must
 * say "per UTC day": the account's bucket is calendar-aligned and hard-resets
 * at midnight UTC, so "rolling" would promise a trailing window the enforcement
 * layer does not implement.
 */
import { readFileSync } from "node:fs";
import { isSubset } from "@mandate/authority-ir";
import { AuthorityIRSchema } from "@mandate/domain/schemas";
import type { AuthorityIR } from "@mandate/domain/schemas";
import { describe, expect, it } from "vitest";
import { buildSubsetView, subsetHeadline } from "../src/proof/subset";

/** The published proof, read from the repository rather than restated here. */
function readPublished(file: string): unknown {
  const path = new URL(`../../../artifacts/evidence/20260818T125522Z/${file}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const tested = AuthorityIRSchema.parse(
  (readPublished("evidence-bundle.json") as { testedAuthority: unknown }).testedAuthority,
);
const granted = AuthorityIRSchema.parse(
  (readPublished("mandate-disclosure.json") as { grantedAuthority: unknown }).grantedAuthority,
);

function withSpend(authority: AuthorityIR, limit: string): AuthorityIR {
  return {
    ...authority,
    spend: authority.spend.map((entry) =>
      entry.token === "NATIVE" ? entry : { ...entry, limit },
    ),
  };
}

describe("buildSubsetView against the published proof", () => {
  const view = buildSubsetView(granted, tested);

  it("agrees with the comparator that the grant is within the trial", () => {
    expect(isSubset(granted, tested).subset).toBe(true);
    expect(view.rowsAgreeWithin).toBe(true);
  });

  it("renders the target and the function the trial covered", () => {
    const target = view.rows.find((row) => row.facet === "TARGET");
    const fn = view.rows.find((row) => row.facet === "FUNCTION");

    expect(target?.tested).toBe("Venus vUSDT");
    expect(target?.granted).toBe("Venus vUSDT");
    expect(fn?.tested).toBe("repayBorrow(uint256)");
    expect(fn?.granted).toBe("repayBorrow(uint256)");
  });

  it("states the spend window as a UTC calendar bucket, never as a rolling one", () => {
    const spend = view.rows.filter((row) => row.facet === "SPEND");
    const usdt = spend.find((row) => row.tested?.startsWith("USDT") === true);

    expect(usdt?.tested).toBe("USDT ≤ 25 per UTC day");
    expect(usdt?.granted).toBe("USDT ≤ 25 per UTC day");
    for (const row of view.rows) {
      expect(`${row.tested ?? ""} ${row.granted ?? ""}`.toLowerCase()).not.toContain("rolling");
    }
  });

  it("discloses the grant's absolute expiry alongside its maximum duration", () => {
    const lifetime = view.rows.find((row) => row.facet === "LIFETIME");
    expect(lifetime?.tested).toBe("7 days max");
    expect(lifetime?.granted).toContain("7 days max, expiring");
    expect(lifetime?.granted).toContain("UTC");
    expect(lifetime?.note).toContain("earlier of the two");
  });
});

describe("buildSubsetView relations", () => {
  it("marks a smaller granted cap as narrower", () => {
    const view = buildSubsetView(withSpend(granted, "10000000"), tested);
    const usdt = view.rows.find((row) => row.facet === "SPEND" && row.tested?.startsWith("USDT") === true);

    expect(usdt?.relation).toBe("NARROWER");
    expect(usdt?.granted).toBe("USDT ≤ 10 per UTC day");
    expect(view.rowsAgreeWithin).toBe(true);
  });

  it("marks a larger granted cap as wider and refuses the within headline", () => {
    const wider = withSpend(granted, "50000000");
    const view = buildSubsetView(wider, tested);
    const usdt = view.rows.find((row) => row.facet === "SPEND" && row.tested?.startsWith("USDT") === true);

    expect(usdt?.relation).toBe("WIDER");
    expect(view.rowsAgreeWithin).toBe(false);
    expect(isSubset(wider, tested).subset).toBe(false);
    expect(subsetHeadline(false)).toBe("A NEW TRIAL IS REQUIRED");
  });

  it("keeps a row for a call the trial tested and the grant left out", () => {
    const narrowed: AuthorityIR = { ...granted, calls: [] };
    const widened: AuthorityIR = {
      ...tested,
      calls: [
        ...tested.calls,
        {
          target: "0x94d1820b2d1c7c7452a163983dc888cec546b77d",
          selector: "0xc5ebeaec",
          signature: "borrow(uint256)",
          protocolId: "venus",
        },
      ],
    };

    const view = buildSubsetView(narrowed, widened);
    const testedOnly = view.rows.filter((row) => row.relation === "TESTED_ONLY");

    expect(testedOnly.length).toBeGreaterThan(0);
    expect(testedOnly.some((row) => row.granted === null)).toBe(true);
    expect(view.rowsAgreeWithin).toBe(true);
  });

  it("flags a call the grant reaches and the trial never tested", () => {
    const overreaching: AuthorityIR = {
      ...granted,
      calls: [
        ...granted.calls,
        {
          target: "0x94d1820b2d1c7c7452a163983dc888cec546b77d",
          selector: "0xc5ebeaec",
          signature: "borrow(uint256)",
          protocolId: "venus",
        },
      ],
    };

    const view = buildSubsetView(overreaching, tested);
    const grantedOnly = view.rows.find((row) => row.relation === "GRANTED_ONLY");

    expect(grantedOnly?.tested).toBeNull();
    expect(grantedOnly?.note).toContain("never tested");
    expect(view.rowsAgreeWithin).toBe(false);
  });
});

describe("subsetHeadline", () => {
  it("prints the two verdicts PRD §85 specifies", () => {
    expect(subsetHeadline(true)).toBe("GRANTED SCOPE IS WITHIN TESTED SCOPE");
    expect(subsetHeadline(false)).toBe("A NEW TRIAL IS REQUIRED");
  });
});

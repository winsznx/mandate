/**
 * TESTED beside GRANTED, one facet per row.
 *
 * The product reduces to one relation: the authority a wallet grants must be no
 * broader than the authority a trial tested. This module turns the two
 * AuthorityIR documents into the rows that show it, and it does not decide the
 * relation — `isSubset` from `@mandate/authority-ir` does, the same comparator
 * the CLI verifier re-runs. Keeping the verdict and the explanation in separate
 * places is deliberate: a renderer that computed its own verdict could disagree
 * with the comparator and the page would have no way to notice.
 *
 * Rows are built from both documents rather than from the granted one alone, so
 * a facet the trial tested and the grant left out still appears. An omission is
 * information — it is the narrowing the whole mechanism exists to produce — and
 * a row list that only walked the grant would silently drop it.
 */
import type { AuthorityCall, AuthorityIR, SpendLimit } from "@mandate/domain/schemas";
import type { Address } from "viem";
import { formatDuration, formatSpendPeriod, formatUnits, formatUtc } from "./format";
import { contractLabel, selectorSignature, tokenInfo } from "./known-addresses";

/**
 * How a granted facet stands to the tested one.
 *
 * `WIDER` and `GRANTED_ONLY` are the two that break the relation. They are
 * named separately because they fail differently: one asks for more of
 * something the trial covered, the other asks for something the trial never
 * looked at.
 */
export type FacetRelation = "SAME" | "NARROWER" | "WIDER" | "TESTED_ONLY" | "GRANTED_ONLY";

export type SubsetFacet = "TARGET" | "FUNCTION" | "SPEND" | "LIFETIME";

export interface SubsetRow {
  /** Stable across renders so a row keeps its identity in the DOM. */
  id: string;
  facet: SubsetFacet;
  /** `null` where the side says nothing about this facet, which is itself the finding. */
  tested: string | null;
  granted: string | null;
  relation: FacetRelation;
  /** Present when the row needs a sentence a reader could not infer from the two cells. */
  note?: string;
}

export interface SubsetView {
  rows: SubsetRow[];
  /** True only when no row widens. The authoritative verdict still comes from the comparator. */
  rowsAgreeWithin: boolean;
}

/** An absent selector means every selector on the target, which is a wider grant, not a missing one. */
const ANY_SELECTOR = "*";

function callKey(call: AuthorityCall): string {
  return `${call.target.toLowerCase()}:${call.selector?.toLowerCase() ?? ANY_SELECTOR}`;
}

function targetText(target: Address): string {
  const label = contractLabel(target);
  return label ?? target;
}

function callSignature(call: AuthorityCall): string {
  if (call.selector === undefined) return "every function on this contract";
  return call.signature ?? selectorSignature(call.selector) ?? call.selector;
}

function spendKey(limit: SpendLimit): string {
  return `${String(limit.token).toLowerCase()}:${limit.period}`;
}

/**
 * `USDT ≤ 25 per UTC day`.
 *
 * "per UTC day" and never "rolling". The account's bucket is a calendar-aligned
 * window that hard-resets at midnight UTC — it is not a trailing 24 hours — and
 * naming it "rolling" would describe an enforcement the contract does not
 * implement.
 */
function spendText(limit: SpendLimit): string {
  const info = tokenInfo(limit.token);
  return `${info.symbol} ≤ ${formatUnits(limit.limit, info.decimals)} ${formatSpendPeriod(limit.period)}`;
}

function lifetimeText(authority: AuthorityIR): string {
  const max = formatDuration(authority.lifetime.maxDurationSeconds);
  if (authority.lifetime.notAfter === undefined) return `${max} max`;
  return `${max} max, expiring ${formatUtc(authority.lifetime.notAfter)}`;
}

/**
 * Build the rows.
 *
 * Ordering is fixed — targets, then functions, then spend, then lifetime — so
 * two different mandates produce comparably shaped tables and a reader who has
 * seen one can read the next without relearning it.
 */
export function buildSubsetView(granted: AuthorityIR, tested: AuthorityIR): SubsetView {
  const rows: SubsetRow[] = [];

  const testedCalls = new Map(tested.calls.map((call) => [callKey(call), call]));
  const grantedCalls = new Map(granted.calls.map((call) => [callKey(call), call]));
  const callKeys = [...new Set([...grantedCalls.keys(), ...testedCalls.keys()])].sort();

  for (const key of callKeys) {
    const testedCall = testedCalls.get(key);
    const grantedCall = grantedCalls.get(key);
    const relation: FacetRelation =
      testedCall !== undefined && grantedCall !== undefined
        ? "SAME"
        : grantedCall !== undefined
          ? "GRANTED_ONLY"
          : "TESTED_ONLY";

    rows.push({
      id: `target:${key}`,
      facet: "TARGET",
      tested: testedCall === undefined ? null : targetText(testedCall.target),
      granted: grantedCall === undefined ? null : targetText(grantedCall.target),
      relation,
      ...(relation === "TESTED_ONLY"
        ? { note: "The trial covered this contract. The grant does not include it." }
        : relation === "GRANTED_ONLY"
          ? { note: "The grant reaches a contract the trial never tested." }
          : {}),
    });

    rows.push({
      id: `function:${key}`,
      facet: "FUNCTION",
      tested: testedCall === undefined ? null : callSignature(testedCall),
      granted: grantedCall === undefined ? null : callSignature(grantedCall),
      relation,
    });
  }

  const testedSpend = new Map(tested.spend.map((limit) => [spendKey(limit), limit]));
  const grantedSpend = new Map(granted.spend.map((limit) => [spendKey(limit), limit]));
  const spendKeys = [...new Set([...grantedSpend.keys(), ...testedSpend.keys()])].sort();

  for (const key of spendKeys) {
    const testedLimit = testedSpend.get(key);
    const grantedLimit = grantedSpend.get(key);

    let relation: FacetRelation;
    if (testedLimit === undefined) {
      relation = "GRANTED_ONLY";
    } else if (grantedLimit === undefined) {
      relation = "TESTED_ONLY";
    } else {
      const testedValue = BigInt(testedLimit.limit);
      const grantedValue = BigInt(grantedLimit.limit);
      relation = grantedValue === testedValue ? "SAME" : grantedValue < testedValue ? "NARROWER" : "WIDER";
    }

    rows.push({
      id: `spend:${key}`,
      facet: "SPEND",
      tested: testedLimit === undefined ? null : spendText(testedLimit),
      granted: grantedLimit === undefined ? null : spendText(grantedLimit),
      relation,
      ...(relation === "TESTED_ONLY"
        ? { note: "The grant sets no cap on this token, so nothing may be spent through it." }
        : relation === "GRANTED_ONLY"
          ? { note: "The grant caps a token the trial set no envelope for." }
          : {}),
    });
  }

  const testedSeconds = tested.lifetime.maxDurationSeconds;
  const grantedSeconds = granted.lifetime.maxDurationSeconds;
  rows.push({
    id: "lifetime",
    facet: "LIFETIME",
    tested: lifetimeText(tested),
    granted: lifetimeText(granted),
    relation:
      grantedSeconds === testedSeconds ? "SAME" : grantedSeconds < testedSeconds ? "NARROWER" : "WIDER",
    ...(granted.lifetime.notAfter === undefined
      ? {}
      : {
          note: "The grant carries an absolute expiry as well as a maximum duration. The session stops at the earlier of the two.",
        }),
  });

  return {
    rows,
    rowsAgreeWithin: !rows.some((row) => row.relation === "WIDER" || row.relation === "GRANTED_ONLY"),
  };
}

/** The line PRD §85 prints under the two columns. */
export function subsetHeadline(subset: boolean): string {
  return subset ? "GRANTED SCOPE IS WITHIN TESTED SCOPE" : "A NEW TRIAL IS REQUIRED";
}

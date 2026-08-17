import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./fixtures.js";

/**
 * An anti-regression guard, aimed at a specific future convenience.
 *
 * `underlyingDecimals` is `number | null`, and null propagates: every consumer
 * has to branch on it, and the branch is tedious. Sooner or later somebody with
 * a red type error and a deadline writes `market.underlyingDecimals ?? 18` and
 * every test in this repository still passes, because 18 is right for the
 * mainnet tokens most fixtures use.
 *
 * This test is the thing that does not pass. It reads the two source trees that
 * touch Venus decimals and fails on the pattern itself, before anyone has to
 * notice the wrong number downstream.
 *
 * It scans source rather than behaviour on purpose. The bug it guards against
 * is invisible in behaviour — a fabricated 18 produces a plausible number, not
 * an exception — and the only reliable moment to catch it is the moment it is
 * written.
 */

const SCANNED = [
  join("packages", "venus-bsc", "src"),
  join("reference", "health-factor", "src"),
];

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Three detectors, because the first two are evadable by renaming a variable.
 *
 * `36 - (d ?? 18)` fabricates exactly the same scale as
 * `36 - (underlyingDecimals ?? 18)` and matches nothing that looks for the word
 * decimals. The third rule closes that by refusing any numeric-literal
 * short-circuit anywhere in these two trees at all — see its note.
 */
const RULES: readonly Rule[] = [
  {
    // `underlyingDecimals ?? 18`, `decimals || 6`, `m.underlyingDecimals ?? 18`,
    // and the same across a line break, since `\s*` spans newlines.
    name: "decimals short-circuited into a literal",
    pattern: /\b\w*[Dd]ecimals\s*(?:\?\?|\|\|)\s*-?\d+/g,
  },
  {
    // `function price({ underlyingDecimals = 18 })` fabricates as hard as `??`
    // does and reads as innocent.
    name: "decimals defaulted in a destructuring or parameter list",
    pattern: /\b\w*[Dd]ecimals\s*=\s*-?\d+\s*[,}\)]/g,
  },
  {
    // Broad on purpose, and safe because it is scoped to two small modules that
    // do nothing but read and price Venus positions. Every bare number that
    // could sit on the right of a `??` in here is a token scale, a mantissa or
    // a weight, and none of them has a defensible default. Both trees contain
    // zero such expressions today, so this costs nothing until someone reaches
    // for one.
    name: "a numeric fallback inside an accounting module",
    pattern: /(?:\?\?|\|\|)\s*-?\d+/g,
  },
];

const WHY = [
  "Venus quotes getUnderlyingPrice at 1e(36 - decimals), so decimals are the scale of the price,",
  "not a display detail. Guessing 18 for the 6-decimal BSC testnet mocks is an error of 1e12:",
  "a $500 position reads as $500,000,000,000,000, and a repayment sized against it is wrong by",
  "the same factor. The assumption is also correct on mainnet and wrong on testnet, so it passes",
  "review and fails in the environment trials actually run in.",
  "",
  "underlyingDecimals is number | null because an unreadable decimals() makes the market",
  "unpriceable, not 18-decimal. The null is the fail-closed path: marketsWithUnpricedExposure",
  "catches it and the reference model reports UNPRICED_EXPOSURE with no health factor and no",
  "action. See VENUS-ACCOUNTING-004.",
  "",
  "A fabricated scale must never justify an autonomous financial action against a user's",
  "account. Branch on the null. Do not fill it in.",
].join("\n");

/** Comments and string bodies are stripped so prose about the pattern is not the pattern. */
function strippedSource(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

function typeScriptFilesUnder(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...typeScriptFilesUnder(full));
      continue;
    }
    if (entry.endsWith(".ts")) found.push(full);
  }
  return found;
}

interface Offence {
  readonly file: string;
  readonly rule: string;
  readonly text: string;
}

function matches(source: string, rule: Rule): readonly { text: string; endsAt: number }[] {
  // The regexes are global and module-scoped, so `lastIndex` has to be reset
  // between files or every second file is scanned from the wrong offset.
  rule.pattern.lastIndex = 0;
  return [...source.matchAll(rule.pattern)].map((match) => ({
    text: match[0].replace(/\s+/g, " "),
    // The raw length, not the collapsed one, so overlapping rules that end on
    // the same literal agree on where that is.
    endsAt: match.index + match[0].length,
  }));
}

function findOffences(): readonly Offence[] {
  const offences: Offence[] = [];
  for (const tree of SCANNED) {
    for (const file of typeScriptFilesUnder(join(REPO_ROOT, tree))) {
      const source = strippedSource(file);
      // The rules overlap by design — every rule-1 hit is also a rule-3 hit —
      // so an occurrence is reported once, under the most specific rule that
      // caught it. They are keyed on where the match ends, which is the literal
      // itself and therefore shared.
      const claimed = new Set<number>();
      for (const rule of RULES) {
        for (const found of matches(source, rule)) {
          if (claimed.has(found.endsAt)) continue;
          claimed.add(found.endsAt);
          offences.push({ file: relative(REPO_ROOT, file), rule: rule.name, text: found.text });
        }
      }
    }
  }
  return offences;
}

describe("no fabricated decimals fallback", () => {
  it("finds no decimals short-circuited into a literal, in either source tree", () => {
    // #given the two source trees that price Venus positions
    // #when they are scanned for a decimals fallback
    const offences = findOffences();

    // #then there are none
    expect(
      offences,
      offences.length === 0
        ? ""
        : `Fabricated decimals fallback found:\n${offences
            .map((offence) => `  ${offence.file}: ${offence.text}  [${offence.rule}]`)
            .join("\n")}\n\n${WHY}`,
    ).toEqual([]);
  });

  it("actually scans both trees, so a passing result means something", () => {
    // #given the directories the guard claims to cover
    // #then each one exists and holds source. A guard silently scanning an
    // empty list is the failure mode that makes every other assertion here a
    // lie, and it is the one a rename would cause.
    for (const tree of SCANNED) {
      expect(typeScriptFilesUnder(join(REPO_ROOT, tree)).length).toBeGreaterThan(0);
    }
  });

  it("detects the pattern it claims to detect", () => {
    // #given each way the mistake is written, including across a line break and
    // with the identifier renamed out of the way
    const samples = [
      "const d = market.underlyingDecimals ?? 18;",
      "const d = decimals || 6;",
      "const d = m.underlyingDecimals ??\n      18;",
      "function price({ underlyingDecimals = 18 }) {}",
      "function price(decimals = 8) {}",
      "return 10n ** BigInt(36 - (d ?? 18));",
    ];

    // #then every one of them matches. The last is the evasion: it fabricates
    // exactly the same scale while mentioning decimals nowhere.
    for (const sample of samples) {
      expect(
        RULES.some((rule) => matches(sample, rule).length > 0),
        `guard missed: ${sample}`,
      ).toBe(true);
    }
  });

  it("does not fire on the legitimate ways decimals appear", () => {
    // #given code that handles the null instead of filling it in, and the VAI
    // record, which is 18 decimals as a fact rather than as a fallback
    const samples = [
      "if (market.underlyingDecimals === null) return null;",
      "const decimals = market.underlyingDecimals;",
      "vai: { decimals: 18 }",
      "underlyingDecimals: decimals.value,",
      "export const NATIVE_UNDERLYING_DECIMALS = 18;",
      'const balance = BigInt(market.vTokenBalance ?? "0");',
      "return 10n ** BigInt(36 - underlyingDecimals);",
    ];

    // #then none of them is flagged. A guard that cries wolf gets deleted, and
    // then the real pattern lands unopposed.
    for (const sample of samples) {
      expect(
        RULES.some((rule) => matches(sample, rule).length > 0),
        `guard false-positived on: ${sample}`,
      ).toBe(false);
    }
  });
});

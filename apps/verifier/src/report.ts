/**
 * Printing a result a judge can act on.
 *
 * Two rules shape this file. Every step prints, including the ones that could
 * not run, because a silently omitted line reads as "fine". And every line
 * carries its reason, because "FAIL" without a cause is an accusation and
 * "SKIP" without a cause is an excuse.
 *
 * The verdict is never rendered as a colour. It is one of four words, followed
 * by a sentence explaining which steps produced it.
 */
import { shortMandateLabel } from "@mandate/domain";
import type { Step, Verdict } from "./steps.js";
import type { VerificationReport } from "./verify.js";

const LABEL_WIDTH = 22;
const STATUS_WIDTH = 7;
const LINE_WIDTH = 100;

function header(report: VerificationReport): string {
  return report.subject.kind === "MANDATE"
    ? `MANDATE ${shortMandateLabel(report.subject.id)}`
    : `TRIAL RECEIPT R-${report.subject.id.slice(2, 8)}`;
}

function field(name: string, value: string): string {
  return `${name.padEnd(LABEL_WIDTH)}${value}`;
}

/** Wrap a reason under its status column so long explanations stay readable. */
function wrap(text: string, indent: number): string[] {
  const width = Math.max(LINE_WIDTH - indent, 40);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function renderStep(step: Step, verbose: boolean): string[] {
  const prefix = `${step.id.padEnd(LABEL_WIDTH)}${step.status.padEnd(STATUS_WIDTH)}`;
  const indent = " ".repeat(LABEL_WIDTH + STATUS_WIDTH);
  const lines: string[] = [];

  const reason = step.reason ?? "";
  const wrapped = wrap(reason, LABEL_WIDTH + STATUS_WIDTH);
  lines.push(`${prefix}${wrapped[0] ?? ""}`.trimEnd());
  for (const line of wrapped.slice(1)) lines.push(`${indent}${line}`);

  if (verbose && step.detail !== undefined) {
    for (const [key, value] of Object.entries(step.detail)) {
      lines.push(`${indent}  ${key}: ${value}`);
    }
  }

  return lines;
}

function verdictExplanation(report: VerificationReport): string {
  const failed = report.steps.filter((step) => step.status === "FAIL").map((step) => step.id);
  const skipped = report.steps.filter((step) => step.status === "SKIP").map((step) => step.id);

  switch (report.verdict) {
    case "FAILED":
      return `A published claim does not hold: ${failed.join(", ")}.`;
    case "STALE":
      return report.receipt === undefined
        ? "The receipt is past its freshness horizon."
        : `Every executed check held, but the receipt stopped being current certification at ${new Date(report.receipt.freshUntil * 1000).toISOString()}. It is history, not a live claim.`;
    case "PARTIALLY VERIFIED":
      return `Nothing contradicts the claim, but ${skipped.length} step(s) could not be checked: ${skipped.join(", ")}.`;
    case "VERIFIED":
      return "Every step was checked against the chain and the disclosed documents, and all of them hold.";
  }
}

export interface RenderOptions {
  verbose?: boolean | undefined;
}

export function renderReport(report: VerificationReport, options: RenderOptions = {}): string {
  const verbose = options.verbose ?? false;
  const lines: string[] = [header(report), ""];

  lines.push(field("network", `${report.network.name} (chain ${report.network.chainId})`));
  lines.push(field("registry", `${report.network.registry}  [${report.network.registrySource}]`));
  lines.push(field("rpc", report.network.rpcUrl));

  if (report.receipt !== undefined) {
    const receipt = report.receipt;
    lines.push(field("receipt", receipt.receiptId));
    lines.push(field("agent", `${receipt.identityRegistry} #${receipt.agentId}`));
    lines.push(field("publisher", receipt.publisher));
    lines.push(field("trial result", receipt.passed ? "PASS" : "FAIL"));
    lines.push(field("evidence", receipt.evidenceURI));
    lines.push(field("fresh until", new Date(receipt.freshUntil * 1000).toISOString()));
  }

  if (report.mandate !== undefined) {
    const mandate = report.mandate;
    lines.push(field("wallet", mandate.wallet));
    lines.push(field("session key", mandate.sessionKeyHash));
    lines.push(field("attested by", mandate.attestedBy));
  }

  lines.push("");
  for (const step of report.steps) lines.push(...renderStep(step, verbose));

  lines.push("", "VERDICT", report.verdict, "", ...wrap(verdictExplanation(report), 0));

  if (report.notes.length > 0) {
    lines.push("", "NOTES");
    for (const note of report.notes) {
      const wrapped = wrap(note, 2);
      lines.push(`- ${wrapped[0] ?? ""}`);
      for (const line of wrapped.slice(1)) lines.push(`  ${line}`);
    }
  }

  return lines.join("\n");
}

/** Exit code by verdict, so the CLI composes into a script or a CI gate. */
export function exitCodeFor(verdict: Verdict): number {
  switch (verdict) {
    case "VERIFIED":
      return 0;
    case "PARTIALLY VERIFIED":
      return 2;
    case "STALE":
      return 3;
    case "FAILED":
      return 1;
  }
}

/**
 * Machine-readable form.
 *
 * `bigint` never reaches here — every wide value is already a decimal string —
 * so the output is plain JSON with no custom replacer.
 */
export function renderJson(report: VerificationReport): string {
  return JSON.stringify(report, null, 2);
}

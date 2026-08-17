/**
 * Run one trial from the command line and write what it produced.
 *
 * Deliberately thin. Scenario selection, agent wiring and receipt publication
 * belong to the queue that calls `runTrial`; this exists so an operator can
 * reproduce a single run by hand and hold the same bytes a verifier will.
 *
 *     pnpm --filter @mandate/trial-runner trial <request-module> <output-dir>
 *
 * The request module default-exports a function returning a `TrialRequest`. It
 * is a module rather than a flag set because a request carries an executor
 * factory and a frozen spec, and flattening those into command-line arguments
 * would mean inventing a second, weaker way to express a trial.
 *
 * Exit codes distinguish the three outcomes that matter operationally: 0 for a
 * completed trial regardless of its verdict, 1 for a trial that could not run,
 * and 2 for a trial whose failure means the queue should stop. A FAIL is a
 * successful run of the harness and must not look like a broken one.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runTrial, type TrialRequest, type TrialRunResult } from "./runner.js";
import { emitTrial } from "./emit.js";

export const EXIT_COMPLETED = 0;
export const EXIT_ERROR = 1;
export const EXIT_QUEUE_PAUSED = 2;

export interface CliOutcome {
  readonly exitCode: number;
  readonly lines: readonly string[];
}

/** Run a trial, write it out, and describe what happened. */
export async function runAndEmit(
  request: TrialRequest,
  directory: string,
): Promise<CliOutcome> {
  const result: TrialRunResult = await runTrial(request);

  if (result.status === "ERROR") {
    return {
      exitCode: result.pausesQueue ? EXIT_QUEUE_PAUSED : EXIT_ERROR,
      lines: [
        `ERROR ${result.kind}`,
        result.detail,
        result.pausesQueue
          ? "the trial queue pauses: no run behind this one can succeed, and no state was fabricated to get past it"
          : "this trial can be retried from the same deterministic scenario",
      ],
    };
  }

  const emitted = await emitTrial(result, directory);

  return {
    exitCode: EXIT_COMPLETED,
    lines: [
      `${result.evidence.evaluator.result} ${result.evidence.category}`,
      `fork block ${result.evidence.environment.forkBlock} (${result.evidence.environment.rpcSourceClass})`,
      `evidenceHash (receipt field) ${result.bundleHash}`,
      `trialSpecHash ${result.trialSpecHash}`,
      `testedAuthorityHash ${result.testedAuthorityHash}`,
      `written to ${emitted.directory}`,
    ],
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const [modulePath, directory] = argv;
  if (modulePath === undefined || directory === undefined) {
    process.stderr.write("usage: trial <request-module> <output-dir>\n");
    return EXIT_ERROR;
  }

  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    default?: () => TrialRequest | Promise<TrialRequest>;
  };
  if (typeof loaded.default !== "function") {
    process.stderr.write(`${modulePath} must default-export a function returning a TrialRequest\n`);
    return EXIT_ERROR;
  }

  const outcome = await runAndEmit(await loaded.default(), resolve(directory));
  process.stdout.write(`${outcome.lines.join("\n")}\n`);
  return outcome.exitCode;
}

// Only when invoked directly, so importing `runAndEmit` from the queue does not
// start a trial as a side effect of loading the module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

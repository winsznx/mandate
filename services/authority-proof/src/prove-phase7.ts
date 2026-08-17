/**
 * The Phase 7 proof.
 *
 *   pnpm proof:phase7 --network bsc-testnet
 *
 * One command runs the whole mandate lifecycle: preflight, a trial against a
 * forked chain, an independent replay of its verdict, a published receipt, a
 * compiled and granted session, a permitted execution, three rejections that are
 * each attributed to the mechanism that produced them, revocation, cleanup, and
 * an independent verifier — then writes a manifest a third party can repeat all
 * of it from.
 *
 * Without a funded key it does every read-only step and stops at the first write
 * with a machine-readable reason. With one, and with `PROOF_CONFIRM=1`, it runs
 * to the end. There is no continuation command and no resume flag: a run that
 * dies mid-sequence leaves a manifest naming the step it died in, and the
 * operator decides what to do about the chain state it can see.
 *
 * Exit codes: 0 the run completed or halted cleanly before any write, 1 a
 * blocker or a failure, 64 a usage error.
 */
import { parseNetwork, Phase7ConfigError } from "./phase7/config.js";
import { runPhase7 } from "./phase7/runner.js";

async function main(): Promise<number> {
  let network: ReturnType<typeof parseNetwork>;
  try {
    network = parseNetwork(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\nusage: proof:phase7 --network bsc-testnet\n`,
    );
    return 64;
  }

  const outcome = await runPhase7(network);
  process.stdout.write(`${outcome.lines.join("\n")}\n\nmanifest: ${outcome.manifestPath}\n`);
  return outcome.exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A configuration error is the operator's and is reported as usage; anything
    // else is a bug here and must not be dressed up as a proof outcome.
    if (error instanceof Phase7ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 64;
      return;
    }
    process.stderr.write(`the Phase 7 run crashed: ${String(error)}\n`);
    process.exitCode = 1;
  });

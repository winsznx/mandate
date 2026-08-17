/**
 * Measure an endpoint from the command line.
 *
 * Prints the two capabilities separately and never averages them into one
 * "retention" figure, because the whole finding is that they differ. The fork
 * probe stays behind `--fork` for the same reason it is opt-in in the library:
 * it spawns an anvil per probe and takes minutes.
 *
 *   pnpm --filter @mandate/rpc-capabilities probe --chain 97
 *   pnpm --filter @mandate/rpc-capabilities probe --chain 56 --fork --fork-max-depth 200000
 */
import { canForkBlock } from "./capabilities.js";
import { DEFAULT_RPC_URLS } from "./known-contracts.js";
import {
  DEFAULT_FORK_BUDGET,
  DEFAULT_HISTORICAL_BUDGET,
  probeRpcCapabilities,
  type SearchBudget,
} from "./probe.js";

interface Args {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly fork: boolean;
  readonly historicalBudget: SearchBudget;
  readonly forkBudget: SearchBudget;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function parseArgs(argv: readonly string[]): Args {
  const chainId = Number(flag(argv, "chain") ?? "97");
  const rpcUrl = flag(argv, "rpc") ?? DEFAULT_RPC_URLS[chainId];
  if (rpcUrl === undefined) {
    throw new Error(`no default RPC for chain ${chainId}; pass --rpc`);
  }
  return {
    chainId,
    rpcUrl,
    fork: argv.includes("--fork"),
    historicalBudget: {
      maxDepth: BigInt(flag(argv, "max-depth") ?? DEFAULT_HISTORICAL_BUDGET.maxDepth.toString(10)),
      maxProbes: Number(flag(argv, "max-probes") ?? DEFAULT_HISTORICAL_BUDGET.maxProbes),
      attempts: Number(flag(argv, "attempts") ?? DEFAULT_HISTORICAL_BUDGET.attempts),
    },
    forkBudget: {
      maxDepth: BigInt(flag(argv, "fork-max-depth") ?? DEFAULT_FORK_BUDGET.maxDepth.toString(10)),
      maxProbes: Number(flag(argv, "fork-max-probes") ?? DEFAULT_FORK_BUDGET.maxProbes),
      attempts: Number(flag(argv, "fork-attempts") ?? DEFAULT_FORK_BUDGET.attempts),
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(`probing ${args.rpcUrl} (chain ${args.chainId})\n`);

  const report = await probeRpcCapabilities({
    rpcUrl: args.rpcUrl,
    chainId: args.chainId,
    historicalBudget: args.historicalBudget,
    ...(args.fork ? { forkBudget: args.forkBudget } : {}),
  });

  const { capabilities } = report;
  const historical = capabilities.historicalCall;
  const fork = capabilities.forkState;

  process.stdout.write(`head                        ${capabilities.latestBlock}\n`);
  process.stdout.write(
    `historical eth_call         oldest ${historical.oldestSuccessfulBlock ?? "none"} ` +
      `(depth ${historical.oldestSuccessfulBlock === undefined ? "n/a" : capabilities.latestBlock - historical.oldestSuccessfulBlock}), ` +
      `searched ${report.historicalCall.testedDepth}, ${report.historicalCall.probes} probes, ` +
      `boundary ${report.historicalCall.boundaryObserved ? `±${report.historicalCall.resolutionBlocks}` : "not reached"}\n`,
  );

  if (report.forkState === undefined) {
    process.stdout.write("anvil fork state            not probed (pass --fork)\n");
  } else {
    process.stdout.write(
      `anvil fork state            oldest ${fork.oldestSuccessfulBlock ?? "none"} ` +
        `(depth ${fork.oldestSuccessfulBlock === undefined ? "n/a" : capabilities.latestBlock - fork.oldestSuccessfulBlock}), ` +
        `searched ${report.forkState.testedDepth}, ${report.forkState.probes} probes, ` +
        `boundary ${report.forkState.boundaryObserved ? `±${report.forkState.resolutionBlocks}` : "not reached"}\n`,
    );
    process.stdout.write(`anvil                       ${report.anvilVersion ?? "unknown"}\n`);
  }

  // The two answers side by side, because the point is that they disagree.
  for (const depth of [2_000n, 20_000n, 100_000n, 1_000_000n]) {
    const block = capabilities.latestBlock - depth;
    process.stdout.write(`canForkBlock(head - ${depth})  ${String(canForkBlock(capabilities, block))}\n`);
  }

  process.stdout.write(`elapsed                     ${report.elapsedMs}ms\n`);
  process.stdout.write(`${JSON.stringify(serialisable(report), null, 2)}\n`);
}

function serialisable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "bigint" ? entry.toString(10) : entry,
    ),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

/**
 * The live Phase 2 proof.
 *
 *   pnpm proof:phase2 --network bsc-testnet
 *
 * Runs the complete bounded-authority sequence against a real chain and writes
 * a proof artifact. Preflight runs first and refuses to perform any write when a
 * prerequisite is missing, so an underfunded key costs nothing and leaves no
 * live session behind.
 *
 * The sequence deliberately proves the negative cases as carefully as the
 * positive one. A demo showing only that a permitted action succeeds
 * demonstrates that a wallet works. The claim MANDATE makes is about what
 * cannot happen, and each rejection below has to be attributed to the specific
 * mechanism that produced it — a transaction that merely fails proves nothing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import type { Address } from "viem";
import { PHASE_2_CHECKS, summarize, type CheckResult, type Phase2CheckId } from "./checks.js";
import { preflight, renderPreflight, type PinnedContract } from "./preflight.js";

const NETWORKS = {
  "bsc-testnet": {
    chainId: 97,
    rpcUrl: process.env.BSC_TESTNET_RPC_URL ?? "https://bsc-testnet-rpc.publicnode.com",
    venus: [
      { label: "Venus vUSDT", address: "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as Address, expectedCodeSize: 4_744 },
      { label: "Venus Comptroller", address: "0x94d1820b2d1c7c7452a163983dc888cec546b77d" as Address, expectedCodeSize: 1_508 },
      { label: "USDT mock (6 dp)", address: "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c" as Address, expectedCodeSize: 2_095 },
    ] satisfies PinnedContract[],
  },
} as const;

type NetworkName = keyof typeof NETWORKS;

function parseNetwork(argv: readonly string[]): NetworkName {
  const index = argv.indexOf("--network");
  const value = index >= 0 ? argv[index + 1] : "bsc-testnet";
  if (value === undefined || !(value in NETWORKS)) {
    throw new Error(`Unknown network '${value ?? ""}'. Known: ${Object.keys(NETWORKS).join(", ")}`);
  }
  return value as NetworkName;
}

/** Every check starts NOT_RUN, so a crash mid-sequence cannot read as a pass. */
function initialResults(): CheckResult[] {
  return PHASE_2_CHECKS.map((check) => ({
    id: check.id as Phase2CheckId,
    status: "NOT_RUN",
    observed: "",
    evidence: [],
  }));
}

function markBlocked(results: CheckResult[], reason: string): CheckResult[] {
  return results.map((result) => ({ ...result, status: "BLOCKED", observed: reason }));
}

const network = parseNetwork(process.argv.slice(2));
const config = NETWORKS[network];

const preflightResult = await preflight({
  chainId: config.chainId,
  rpcUrl: config.rpcUrl,
  adminPrivateKey: process.env.DEPLOYER_PRIVATE_KEY,
  venusTargets: config.venus,
});

process.stdout.write(`${renderPreflight(preflightResult)}\n\n`);

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = join(here, "..", "..", "..", "artifacts", "phase-2");
mkdirSync(artifactDir, { recursive: true });

if (preflightResult.status === "BLOCKED") {
  const results = markBlocked(initialResults(), preflightResult.blockers.join("; "));
  process.stdout.write(`${summarize(results)}\n`);
  // No writes were performed, so nothing needs cleaning up and the artifact
  // records why rather than pretending the run happened.
  writeFileSync(
    join(artifactDir, `${network}-preflight.json`),
    `${JSON.stringify({ network, status: "BLOCKED", blockers: preflightResult.blockers, checks: results }, null, 2)}\n`,
    "utf8",
  );
  process.exitCode = 1;
} else {
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const head = await client.getBlockNumber();
  process.stdout.write(
    [
      "Preflight passed. The live sequence runs from here:",
      "  grant session -> reconstruct enforced authority -> compare requested vs enforced",
      "  -> repay at the cap -> repay past the cap (expect ExceededSpendLimit)",
      "  -> wrong selector, wrong target (expect UnauthorizedCall)",
      "  -> revoke -> prove post-revoke failure -> write proof artifact",
      "",
      `Head is ${head}. Session grant costs real tBNB and cannot be undone.`,
      "Set PROOF_CONFIRM=1 to execute.",
      "",
    ].join("\n"),
  );

  if (process.env.PROOF_CONFIRM !== "1") {
    process.stdout.write("Halted before the first write. Nothing was granted or spent.\n");
    process.exitCode = 0;
  } else {
    // The live sequence is wired in `sequence.ts` once a funded key exists.
    // Until one does, refusing loudly is better than a partial run that leaves
    // a live session on a wallet nobody is watching.
    throw new Error(
      "The live sequence has not been exercised against a funded key yet. Run preflight first and review artifacts/phase-2/.",
    );
  }
}

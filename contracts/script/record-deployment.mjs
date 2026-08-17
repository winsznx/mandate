#!/usr/bin/env node
/**
 * Turn a Foundry broadcast log into a deployment record.
 *
 * The record exists so that "which bytecode is at this address, built from
 * which commit, by which compiler" is answerable a year from now without
 * archaeology. Every field is copied from something Foundry or git already
 * knows; nothing here is typed by hand, because a hand-maintained address list
 * is exactly the artifact that goes stale first.
 *
 * Run after `forge script ... --broadcast`:
 *
 *     node script/record-deployment.mjs 97
 *     node script/record-deployment.mjs 31337 --out /tmp/local.json
 *
 * The transaction hash is why this is a separate step: it does not exist while
 * the deploy script is running, only once the transaction has been mined and
 * Foundry has written `broadcast/<script>/<chainId>/run-latest.json`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_NAME = "MandateReceiptRegistry";
const CONTRACT_PATH = `src/${CONTRACT_NAME}.sol:${CONTRACT_NAME}`;

/** Chains Sourcify serves and MANDATE publishes to. */
const NETWORK_NAMES = new Map([
  [56, "BSC Mainnet"],
  [97, "BSC Testnet"],
  [31337, "Anvil (local)"],
]);

const SOURCIFY_CHAINS = new Set([56, 97]);

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`record-deployment: ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Find the broadcast log for this chain.
 *
 * Searched rather than derived from the script name so that renaming a deploy
 * script does not silently stop producing records.
 */
function findBroadcast(chainId) {
  const broadcastDir = join(contractsDir, "broadcast");
  if (!existsSync(broadcastDir)) {
    fail(`no broadcast directory; run \`forge script ... --broadcast\` first`);
  }

  const candidates = [];
  for (const scriptDir of readdirSync(broadcastDir)) {
    const runPath = join(broadcastDir, scriptDir, String(chainId), "run-latest.json");
    if (existsSync(runPath)) candidates.push({ scriptDir, runPath, run: readJson(runPath) });
  }

  if (candidates.length === 0) {
    fail(`no broadcast log for chain ${chainId} under broadcast/*/${chainId}/run-latest.json`);
  }

  // Several scripts can have touched the same chain. The most recent run is the
  // one that produced the current deployment.
  candidates.sort((a, b) => Number(b.run.timestamp ?? 0) - Number(a.run.timestamp ?? 0));
  return candidates[0];
}

function findDeployment(run) {
  const creation = (run.transactions ?? []).find(
    (tx) => tx.transactionType === "CREATE" && tx.contractName === CONTRACT_NAME,
  );
  if (creation === undefined) {
    fail(`broadcast log contains no CREATE transaction for ${CONTRACT_NAME}`);
  }

  const receipt = (run.receipts ?? []).find(
    (candidate) => candidate.transactionHash?.toLowerCase() === creation.hash?.toLowerCase(),
  );
  if (receipt === undefined) {
    fail(`no mined receipt for ${creation.hash}; the broadcast may not have confirmed`);
  }
  if (receipt.status !== undefined && BigInt(receipt.status) !== 1n) {
    fail(`deployment transaction ${creation.hash} reverted`);
  }

  return { creation, receipt };
}

/**
 * Compiler settings straight out of the artifact that produced the bytecode.
 *
 * Taken from the build rather than from `foundry.toml`, because a stale `out/`
 * and an edited config disagree, and the artifact is the one that was actually
 * deployed.
 */
function readCompilation() {
  const artifactPath = join(contractsDir, "out", `${CONTRACT_NAME}.sol`, `${CONTRACT_NAME}.json`);
  if (!existsSync(artifactPath)) fail(`no build artifact at out/; run \`forge build\``);

  const artifact = readJson(artifactPath);
  const settings = artifact.metadata?.settings ?? {};
  return {
    solc: artifact.metadata?.compiler?.version ?? null,
    evmVersion: settings.evmVersion ?? null,
    optimizer: settings.optimizer?.enabled ?? null,
    optimizerRuns: settings.optimizer?.runs ?? null,
    bytecodeHash: settings.metadata?.bytecodeHash ?? null,
    deployedBytecodeSize: artifact.deployedBytecode?.object
      ? (artifact.deployedBytecode.object.length - 2) / 2
      : null,
  };
}

/**
 * Foundry's broadcast timestamp, normalised.
 *
 * The field has been seconds in some Foundry versions and milliseconds in
 * others, and guessing wrong silently records a date in the year 58596.
 * Anything past the year 2100 in seconds is milliseconds.
 */
function broadcastTimestamp(raw) {
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const millis = value > 4_102_444_800 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function readCommit() {
  const git = (...args) => execFileSync("git", args, { cwd: contractsDir, encoding: "utf8" }).trim();
  try {
    // A dirty tree means the recorded sha does not describe what was compiled,
    // which is worth carrying in the record rather than discovering later.
    return { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").length > 0 };
  } catch {
    return { sha: null, dirty: null };
  }
}

/**
 * Ask Sourcify whether the address is already verified.
 *
 * Sourcify rather than Etherscan: `api.bscscan.com` V1 is dead and Etherscan V2
 * is paid-tier for BSC, so Sourcify is the only key-free path that works for
 * chains 56 and 97.
 */
async function readSourcify(chainId, address) {
  if (!SOURCIFY_CHAINS.has(chainId)) {
    return { verifier: "sourcify", status: "NOT_APPLICABLE", checkedAt: null };
  }
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=compilation`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const checkedAt = new Date().toISOString();
    if (response.ok) return { verifier: "sourcify", status: "VERIFIED", checkedAt };
    if (response.status === 404) return { verifier: "sourcify", status: "NOT_VERIFIED", checkedAt };
    return { verifier: "sourcify", status: `HTTP_${response.status}`, checkedAt };
  } catch (error) {
    return { verifier: "sourcify", status: "UNREACHABLE", error: String(error), checkedAt: null };
  }
}

async function main() {
  const [rawChainId, ...rest] = process.argv.slice(2);
  if (rawChainId === undefined) fail("usage: record-deployment.mjs <chainId> [--out <path>]");

  const chainId = Number(rawChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) fail(`invalid chain id ${rawChainId}`);

  const outFlag = rest.indexOf("--out");
  const outPath =
    outFlag >= 0 && rest[outFlag + 1] !== undefined
      ? resolve(rest[outFlag + 1])
      : join(contractsDir, "deployments", `${chainId}.json`);

  const { scriptDir, run } = findBroadcast(chainId);
  const { creation, receipt } = findDeployment(run);
  const address = creation.contractAddress;

  const record = {
    chainId,
    network: NETWORK_NAMES.get(chainId) ?? `chain ${chainId}`,
    contract: CONTRACT_PATH,
    address,
    txHash: creation.hash,
    deployer: creation.transaction?.from ?? null,
    blockNumber: Number(BigInt(receipt.blockNumber)),
    broadcastScript: scriptDir,
    broadcastAt: broadcastTimestamp(run.timestamp),
    compilation: readCompilation(),
    commit: readCommit(),
    verification: await readSourcify(chainId, address),
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`recorded ${CONTRACT_NAME} at ${address} on chain ${chainId} -> ${outPath}`);
  if (record.commit.dirty) {
    console.warn("warning: the working tree was dirty, so the recorded commit is not what was compiled");
  }
  if (record.verification.status === "NOT_VERIFIED") {
    console.warn(
      `warning: not verified on Sourcify. Run:\n` +
        `  forge verify-contract ${address} ${CONTRACT_PATH} --chain-id ${chainId} --verifier sourcify`,
    );
  }
}

await main();

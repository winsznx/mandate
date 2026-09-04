/**
 * Register the eight reference agents on the ERC-8004 IdentityRegistry (BSC 97).
 *
 * The marketplace binds a card to an identity only when an on-chain registration
 * resolves to a URL ending in that card's slug. So each agent is registered with
 *
 *   agentURI = https://<gateway>/<slug>.json
 *
 * which the gateway Worker serves as that agent's card. The resulting agent id
 * is written to `artifacts/registrations.json`, which the card emitter folds
 * into `x-mandate.agentId` and the gateway serves alongside the card.
 *
 * Idempotent. An agent already registered to the right URI is left alone; one
 * registered to a stale URI (health-factor-a, minted as #1842 against a
 * placeholder) is repointed with setAgentURI rather than re-minted.
 *
 * Run:  cd packages/altana && node --import tsx ../../scripts/register-agents.ts
 * Add --confirm to actually send transactions; without it the script only reports.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeEventLog, http, isAddressEqual } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const REGISTRATIONS_PATH = `${repoRoot}artifacts/registrations.json`;

const IDENTITY_REGISTRY: Address = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const GATEWAY = "https://mandate-agents.timjosh507.workers.dev";
const SLUGS = [
  "grid-a",
  "grid-b",
  "health-factor-a",
  "health-factor-b",
  "rebalancing-a",
  "rebalancing-b",
  "yield-a",
  "yield-b",
] as const;

/** Agents already minted before this script existed. */
const KNOWN_IDS: Partial<Record<(typeof SLUGS)[number], string>> = {
  "health-factor-a": "1842",
};

const ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setAgentURI", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }], outputs: [] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

function readEnv(): Record<string, string> {
  const raw = readFileSync(`${repoRoot}.env`, "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

type Registration = { agentId: string; agentURI: string; owner: string; txHash?: string; note?: string };

function loadRegistrations(): Record<string, Registration> {
  try {
    return JSON.parse(readFileSync(REGISTRATIONS_PATH, "utf8")) as Record<string, Registration>;
  } catch {
    return {};
  }
}

function saveRegistrations(data: Record<string, Registration>): void {
  const ordered = Object.fromEntries(
    SLUGS.filter((slug) => data[slug] !== undefined).map((slug) => [slug, data[slug]]),
  );
  writeFileSync(REGISTRATIONS_PATH, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const env = readEnv();
  const rpcUrl = env["BSC_TESTNET_RPC_URL"] ?? "https://bsc-testnet-rpc.publicnode.com";
  const pk = env["DEPLOYER_PRIVATE_KEY"];
  if (pk === undefined || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error("DEPLOYER_PRIVATE_KEY missing or malformed in .env");
  }

  const account = privateKeyToAccount(pk as Hex);
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  console.log(`registrar ${account.address}`);
  console.log(`registry  ${IDENTITY_REGISTRY}`);
  console.log(`mode      ${confirm ? "CONFIRM — sending transactions" : "dry run (pass --confirm to send)"}\n`);

  const registrations = loadRegistrations();

  for (const slug of SLUGS) {
    const agentURI = `${GATEWAY}/${slug}.json`;
    const existing = registrations[slug];
    const knownId = existing?.agentId ?? KNOWN_IDS[slug];

    if (knownId !== undefined) {
      const [onChainUri, owner] = await Promise.all([
        publicClient.readContract({ address: IDENTITY_REGISTRY, abi: ABI, functionName: "tokenURI", args: [BigInt(knownId)] }),
        publicClient.readContract({ address: IDENTITY_REGISTRY, abi: ABI, functionName: "ownerOf", args: [BigInt(knownId)] }),
      ]);

      if (!isAddressEqual(owner, account.address)) {
        console.log(`${slug}: #${knownId} owned by ${owner}, not the registrar — skipped`);
        continue;
      }
      if (onChainUri === agentURI) {
        console.log(`${slug}: #${knownId} already points at ${agentURI}`);
        registrations[slug] = { agentId: knownId, agentURI, owner: account.address, ...(existing?.txHash ? { txHash: existing.txHash } : {}) };
        saveRegistrations(registrations);
        continue;
      }

      console.log(`${slug}: #${knownId} points at "${onChainUri}" — repoint to ${agentURI}`);
      if (!confirm) continue;
      const hash = await walletClient.writeContract({
        address: IDENTITY_REGISTRY, abi: ABI, functionName: "setAgentURI", args: [BigInt(knownId), agentURI], chain: null,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      registrations[slug] = { agentId: knownId, agentURI, owner: account.address, txHash: hash, note: "repointed via setAgentURI" };
      saveRegistrations(registrations);
      console.log(`  repointed in ${hash}`);
      continue;
    }

    console.log(`${slug}: not registered — register ${agentURI}`);
    if (!confirm) continue;
    const hash = await walletClient.writeContract({
      address: IDENTITY_REGISTRY, abi: ABI, functionName: "register", args: [agentURI], chain: null,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    let agentId: string | undefined;
    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, IDENTITY_REGISTRY)) continue;
      try {
        const parsed = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
        if (parsed.eventName === "Registered") {
          agentId = (parsed.args.agentId as bigint).toString();
          break;
        }
      } catch {
        // not the event we want
      }
    }
    if (agentId === undefined) throw new Error(`${slug}: no Registered event in ${hash}`);

    registrations[slug] = { agentId, agentURI, owner: account.address, txHash: hash };
    saveRegistrations(registrations);
    console.log(`  registered as #${agentId} in ${hash}`);
  }

  console.log(`\nwrote ${REGISTRATIONS_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

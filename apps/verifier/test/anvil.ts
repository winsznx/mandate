/**
 * A real chain for the end-to-end suite.
 *
 * The verifier's whole claim is that it reads a contract rather than a
 * database, so testing it against a mocked registry would test the mock. Anvil
 * plus the actual deploy script is cheap enough that there is no reason to.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const execFileAsync = promisify(execFile);

export const CONTRACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts");

/** Anvil's first deterministic account. Public knowledge, and worthless outside a local node. */
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

export interface AnvilHandle {
  rpcUrl: string;
  chainId: number;
  registry: Address;
  deployer: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not acquire a port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForRpc(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch {
      // The node is still binding its socket.
    }
    await new Promise((sleep) => setTimeout(sleep, 50));
  }
  throw new Error(`anvil at ${url} did not become ready`);
}

/**
 * Start Anvil and deploy the registry with the real deploy script.
 *
 * Going through `forge script` rather than a direct `CREATE` is deliberate: it
 * keeps `DeployBase`'s post-deployment assertions on the tested path, so the
 * testnet and mainnet scripts are not code that runs for the first time on the
 * day it matters.
 */
export async function startAnvilWithRegistry(): Promise<AnvilHandle> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const anvil: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--silent"], {
    stdio: "ignore",
  });

  await waitForRpc(rpcUrl, 20_000);

  await execFileAsync(
    "forge",
    ["script", "script/DeployLocal.s.sol", "--rpc-url", rpcUrl, "--private-key", DEPLOYER_KEY, "--broadcast"],
    { cwd: CONTRACTS_DIR, maxBuffer: 32 * 1024 * 1024 },
  );

  const account = privateKeyToAccount(DEPLOYER_KEY);
  const chain = defineChain({
    id: 31337,
    name: "Anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const registry = await registryFromBroadcast();

  return {
    rpcUrl,
    chainId: 31337,
    registry,
    deployer: account.address.toLowerCase() as Address,
    publicClient,
    walletClient,
    stop: async () => {
      anvil.kill("SIGKILL");
      await new Promise((sleep) => setTimeout(sleep, 20));
    },
  };
}

async function registryFromBroadcast(): Promise<Address> {
  const { readFile } = await import("node:fs/promises");
  const path = resolve(CONTRACTS_DIR, "broadcast", "DeployLocal.s.sol", "31337", "run-latest.json");
  const run = JSON.parse(await readFile(path, "utf8")) as {
    transactions: Array<{ transactionType: string; contractName: string; contractAddress: string }>;
  };
  const created = run.transactions.find(
    (tx) => tx.transactionType === "CREATE" && tx.contractName === "MandateReceiptRegistry",
  );
  if (created === undefined) throw new Error("the deploy script broadcast no registry creation");
  return created.contractAddress.toLowerCase() as Address;
}

/**
 * Write runtime code that answers every call with a fixed 32-byte word.
 *
 * Enough to stand in for an ERC-8004 identity registry's `ownerOf`, which is
 * all the verifier asks of it. Anvil has no ERC-8004 deployment, and the
 * alternative — skipping the on-chain identity probe in every test — would
 * leave that branch unexercised.
 */
export async function setStubContract(rpcUrl: string, address: Address, word: Hex): Promise<void> {
  // PUSH32 <word>; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN
  await setCode(rpcUrl, address, `0x7f${word.slice(2)}60005260206000f3`);
}

/**
 * Runtime code that reverts with exactly `data`, whatever it is called with.
 *
 * Needed because the enforcement layer's rejections are custom errors from a
 * contract this repository does not own and cannot deploy. Emitting the revert
 * payload from raw bytecode is the only way to put a real `ExceededSpendLimit`
 * — and, more importantly, a convincing impostor — on a local chain.
 */
export function revertingCode(data: Hex): Hex {
  const body = data.slice(2);
  const byteLength = body.length / 2;
  let code = "";

  for (let offset = 0; offset < byteLength; offset += 32) {
    const chunk = body.slice(offset * 2, offset * 2 + 64).padEnd(64, "0");
    code += `7f${chunk}61${offset.toString(16).padStart(4, "0")}52`;
  }
  code += `61${byteLength.toString(16).padStart(4, "0")}6000fd`;

  return `0x${code}`;
}

/**
 * Runtime code that answers every call with exactly `data`.
 *
 * The sibling of `revertingCode`, and it exists for the same reason: the
 * account contract whose permission storage the verifier reads belongs to
 * another system and cannot be deployed here. Returning a pre-encoded answer
 * puts the "the account holds this key" and "the account holds nothing"
 * branches on a real chain instead of leaving them untested.
 */
export function returningCode(data: Hex): Hex {
  const body = data.slice(2);
  const byteLength = body.length / 2;
  let code = "";

  for (let offset = 0; offset < byteLength; offset += 32) {
    const chunk = body.slice(offset * 2, offset * 2 + 64).padEnd(64, "0");
    code += `7f${chunk}61${offset.toString(16).padStart(4, "0")}52`;
  }
  code += `61${byteLength.toString(16).padStart(4, "0")}6000f3`;

  return `0x${code}`;
}

export async function setCode(rpcUrl: string, address: Address, code: Hex | string): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setCode", params: [address, code] }),
  });
  const body = (await response.json()) as { error?: { message: string } };
  if (body.error !== undefined) throw new Error(`anvil_setCode failed: ${body.error.message}`);
}

/** The registry's write surface. The verifier itself only ever reads, so it does not carry this. */
export const REGISTRY_WRITE_ABI = [
  {
    name: "publishReceipt",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "receipt",
        type: "tuple",
        components: [
          { name: "identityRegistry", type: "address" },
          { name: "agentId", type: "uint256" },
          { name: "agentVersionHash", type: "bytes32" },
          { name: "trialSpecHash", type: "bytes32" },
          { name: "testedAuthorityHash", type: "bytes32" },
          { name: "scenarioHash", type: "bytes32" },
          { name: "evaluatorHash", type: "bytes32" },
          { name: "referenceModelHash", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "snapshotBlock", type: "uint64" },
          { name: "createdAt", type: "uint64" },
          { name: "freshUntil", type: "uint64" },
          { name: "passed", type: "bool" },
        ],
      },
      { name: "evidenceURI", type: "string" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "recordActivation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "trialReceiptId", type: "bytes32" },
      { name: "wallet", type: "address" },
      { name: "sessionKeyHash", type: "bytes32" },
      { name: "grantedAuthorityHash", type: "bytes32" },
      { name: "sequence", type: "uint32" },
      { name: "disclosureURI", type: "string" },
      { name: "validFrom", type: "uint64" },
      { name: "validUntil", type: "uint64" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "recordRevocation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "mandateId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "computeReceiptId",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        name: "receipt",
        type: "tuple",
        components: [
          { name: "identityRegistry", type: "address" },
          { name: "agentId", type: "uint256" },
          { name: "agentVersionHash", type: "bytes32" },
          { name: "trialSpecHash", type: "bytes32" },
          { name: "testedAuthorityHash", type: "bytes32" },
          { name: "scenarioHash", type: "bytes32" },
          { name: "evaluatorHash", type: "bytes32" },
          { name: "referenceModelHash", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "snapshotBlock", type: "uint64" },
          { name: "createdAt", type: "uint64" },
          { name: "freshUntil", type: "uint64" },
          { name: "passed", type: "bool" },
        ],
      },
      { name: "publisher", type: "address" },
      { name: "evidenceURI", type: "string" },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

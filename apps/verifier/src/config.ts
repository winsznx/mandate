/**
 * Where the verifier points, and how little it needs to be told.
 *
 * The default path is a receipt id and nothing else. Everything else resolves
 * from public constants and from the repository's own deployment records, so
 * the barrier to checking a MANDATE claim is a checkout and a chain RPC.
 *
 * Order of precedence is explicit flag, then environment, then repository
 * default. An operator can therefore point the verifier at their own RPC or at
 * a registry deployed by someone else, which is the property that stops this
 * from being MANDATE grading its own homework.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, isAddress } from "viem";
import type { Address, PublicClient } from "viem";

/** Verified reachable, and the only free BSC endpoints with usable `eth_getLogs`. */
export const DEFAULT_RPC_URLS: Record<number, string> = {
  56: "https://bsc-rpc.publicnode.com",
  97: "https://bsc-testnet-rpc.publicnode.com",
  31337: "http://127.0.0.1:8545",
};

export const NETWORK_NAMES: Record<number, string> = {
  56: "BSC Mainnet",
  97: "BSC Testnet",
  31337: "Anvil (local)",
};

/** MANDATE's first deployment target. A judge who passes no flags checks testnet. */
export const DEFAULT_CHAIN_ID = 97;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentsDir = resolve(packageRoot, "..", "..", "contracts", "deployments");

export interface ResolvedTarget {
  chainId: number;
  rpcUrl: string;
  registry: Address;
  networkName: string;
  /** How the registry address was found, so the report can say whose registry was read. */
  registrySource: string;
}

export interface TargetOverrides {
  chainId?: number | undefined;
  rpcUrl?: string | undefined;
  registry?: string | undefined;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Read the registry address out of `contracts/deployments/<chainId>.json`.
 *
 * A committed file rather than a lookup service. The address is a public fact
 * that changes once per chain, and putting it behind an API would reintroduce
 * exactly the dependency the verifier exists to avoid.
 */
function registryFromDeployments(chainId: number): { address: Address; source: string } {
  const path = join(deploymentsDir, `${chainId}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new ConfigurationError(
      `no registry address for chain ${chainId}. There is no contracts/deployments/${chainId}.json, so pass --registry <address> or set MANDATE_REGISTRY_ADDRESS.`,
    );
  }

  const record = JSON.parse(raw) as { address?: unknown };
  if (typeof record.address !== "string" || !isAddress(record.address, { strict: false })) {
    throw new ConfigurationError(`contracts/deployments/${chainId}.json has no usable "address" field`);
  }
  return { address: record.address.toLowerCase() as Address, source: `contracts/deployments/${chainId}.json` };
}

export function resolveTarget(overrides: TargetOverrides = {}): ResolvedTarget {
  const chainId =
    overrides.chainId ??
    (process.env["MANDATE_CHAIN_ID"] === undefined
      ? DEFAULT_CHAIN_ID
      : Number(process.env["MANDATE_CHAIN_ID"]));

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new ConfigurationError(`invalid chain id ${String(chainId)}`);
  }

  const rpcUrl = overrides.rpcUrl ?? process.env["MANDATE_RPC_URL"] ?? DEFAULT_RPC_URLS[chainId];
  if (rpcUrl === undefined) {
    throw new ConfigurationError(
      `no default RPC for chain ${chainId}; pass --rpc <url> or set MANDATE_RPC_URL`,
    );
  }

  const explicit = overrides.registry ?? process.env["MANDATE_REGISTRY_ADDRESS"];
  const resolved =
    explicit === undefined
      ? registryFromDeployments(chainId)
      : { address: explicit.toLowerCase() as Address, source: overrides.registry ? "--registry" : "MANDATE_REGISTRY_ADDRESS" };

  if (!isAddress(resolved.address, { strict: false })) {
    throw new ConfigurationError(`"${resolved.address}" is not an address`);
  }

  return {
    chainId,
    rpcUrl,
    registry: resolved.address,
    networkName: NETWORK_NAMES[chainId] ?? `chain ${chainId}`,
    registrySource: resolved.source,
  };
}

/**
 * A read-only client, with the chain id confirmed against the endpoint.
 *
 * Confirming matters because receipt ids commit to `block.chainid`. Reading a
 * mainnet registry through a testnet RPC would not error; it would silently
 * fail every id recomputation, and the resulting report would blame the
 * publisher for the operator's misconfiguration.
 */
export async function createClient(target: ResolvedTarget): Promise<PublicClient> {
  const client = createPublicClient({ transport: http(target.rpcUrl) }) as PublicClient;

  let reported: number;
  try {
    reported = await client.getChainId();
  } catch (error) {
    throw new ConfigurationError(`RPC ${target.rpcUrl} is unreachable: ${String(error)}`);
  }

  if (reported !== target.chainId) {
    throw new ConfigurationError(
      `RPC ${target.rpcUrl} serves chain ${reported}, but chain ${target.chainId} was requested`,
    );
  }

  return client;
}

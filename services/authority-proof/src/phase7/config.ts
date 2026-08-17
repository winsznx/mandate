/**
 * Everything the run is told, resolved once.
 *
 * Read at the top so that a missing input is a preflight blocker rather than a
 * `undefined` that surfaces halfway through a sequence which has already granted
 * a session. Nothing below reaches for `process.env` again.
 *
 * Two defaults are worth naming. The mandate wallet defaults to the deployer's
 * own address because an Altana wallet IS the admin signer's EIP-7702 EOA, so
 * asking the operator to restate it would only create a way to get it wrong. The
 * agent id defaults to `0`, which means unregistered: the read-only lane runs
 * happily against it and the write lane refuses, because publishing a receipt
 * against an identity nobody minted would be a fabricated claim.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAddress } from "viem";
import type { Address, Hex } from "viem";
import { deploymentFor, type AltanaDeployment } from "@mandate/altana";
import { venusDeploymentFor, type VenusDeployment } from "@mandate/venus-bsc";

export const NETWORKS = {
  "bsc-testnet": {
    chainId: 97,
    name: "BSC Testnet",
    defaultRpcUrl: "https://bsc-testnet-rpc.publicnode.com",
    /** ERC-8004 IdentityRegistry on 97. `0x8004Cc84…` has zero code here; do not substitute it. */
    identityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e" as Address,
  },
} as const;

export type NetworkName = keyof typeof NETWORKS;

export const UNREGISTERED_AGENT_ID = "0";

export class Phase7ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase7ConfigError";
  }
}

export interface Phase7Config {
  network: NetworkName;
  chainId: number;
  networkName: string;
  rpcUrl: string;
  altana: AltanaDeployment;
  venus: VenusDeployment;
  /** Present only when a key was supplied. The key itself never leaves this object. */
  deployerPrivateKey?: Hex;
  /** The wallet the session is granted on. Defaults to the deployer's own address. */
  walletAddress?: Address;
  /** Where receipts are published. Absent means the write lane cannot run. */
  registryAddress?: Address;
  registrySource: string;
  /** Base URI the evidence and disclosure documents will be reachable at. */
  evidenceBaseUri?: string;
  identityRegistry: Address;
  agentId: string;
  agentRegistrationUri: string;
  /** True when the operator has explicitly accepted that writes spend real tBNB. */
  confirmed: boolean;
}

export function parseNetwork(argv: readonly string[]): NetworkName {
  const index = argv.indexOf("--network");
  const value = index >= 0 ? argv[index + 1] : "bsc-testnet";
  if (value === undefined || !(value in NETWORKS)) {
    throw new Phase7ConfigError(
      `Unknown network '${value ?? ""}'. Known: ${Object.keys(NETWORKS).join(", ")}`,
    );
  }
  return value as NetworkName;
}

function registryFromDeployments(chainId: number): { address?: Address; source: string } {
  const path = fileURLToPath(
    new URL(`../../../../contracts/deployments/${chainId}.json`, import.meta.url),
  );
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { source: `contracts/deployments/${chainId}.json (absent)` };
  }
  const record = JSON.parse(raw) as { address?: unknown };
  if (typeof record.address !== "string" || !isAddress(record.address, { strict: false })) {
    return { source: `contracts/deployments/${chainId}.json (no usable address field)` };
  }
  return {
    address: record.address.toLowerCase() as Address,
    source: `contracts/deployments/${chainId}.json`,
  };
}

function optionalAddress(value: string | undefined, label: string): Address | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isAddress(value, { strict: false })) {
    throw new Phase7ConfigError(`${label} is not an address: '${value}'`);
  }
  return value.toLowerCase() as Address;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export function resolveConfig(
  network: NetworkName,
  env: EnvSource = process.env,
): Phase7Config {
  const chain = NETWORKS[network];
  const deployerPrivateKey = env["DEPLOYER_PRIVATE_KEY"];

  const explicitRegistry = optionalAddress(env["MANDATE_REGISTRY_ADDRESS"], "MANDATE_REGISTRY_ADDRESS");
  const registry =
    explicitRegistry === undefined
      ? registryFromDeployments(chain.chainId)
      : { address: explicitRegistry, source: "MANDATE_REGISTRY_ADDRESS" };

  const agentId = env["MANDATE_AGENT_ID"] ?? UNREGISTERED_AGENT_ID;
  if (!/^\d+$/.test(agentId)) {
    throw new Phase7ConfigError(`MANDATE_AGENT_ID must be a decimal integer, received '${agentId}'`);
  }

  const config: Phase7Config = {
    network,
    chainId: chain.chainId,
    networkName: chain.name,
    rpcUrl: env["BSC_TESTNET_RPC_URL"] ?? chain.defaultRpcUrl,
    altana: deploymentFor(chain.chainId),
    venus: venusDeploymentFor(chain.chainId),
    registrySource: registry.source,
    identityRegistry:
      optionalAddress(env["MANDATE_IDENTITY_REGISTRY"], "MANDATE_IDENTITY_REGISTRY") ??
      chain.identityRegistry,
    agentId,
    agentRegistrationUri:
      env["MANDATE_AGENT_REGISTRATION_URI"] ?? "mandate://unregistered/health-factor-a",
    confirmed: env["PROOF_CONFIRM"] === "1",
  };

  if (deployerPrivateKey !== undefined && deployerPrivateKey !== "") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(deployerPrivateKey)) {
      throw new Phase7ConfigError("DEPLOYER_PRIVATE_KEY must be 32 hex bytes with an 0x prefix");
    }
    config.deployerPrivateKey = deployerPrivateKey as Hex;
  }

  const wallet = optionalAddress(env["MANDATE_WALLET_ADDRESS"], "MANDATE_WALLET_ADDRESS");
  if (wallet !== undefined) config.walletAddress = wallet;
  if (registry.address !== undefined) config.registryAddress = registry.address;

  const evidenceBaseUri = env["MANDATE_EVIDENCE_BASE_URI"];
  if (evidenceBaseUri !== undefined && evidenceBaseUri !== "") {
    config.evidenceBaseUri = evidenceBaseUri.endsWith("/")
      ? evidenceBaseUri
      : `${evidenceBaseUri}/`;
  }

  return config;
}

/** The URI a document written under `artifacts/phase-7/<runId>/` will be reachable at. */
export function evidenceUriFor(config: Phase7Config, runId: string, filename: string): string {
  if (config.evidenceBaseUri === undefined) {
    throw new Phase7ConfigError("no evidence base URI is configured");
  }
  return `${config.evidenceBaseUri}${runId}/${filename}`;
}

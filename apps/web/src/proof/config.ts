/**
 * Where the proof page points.
 *
 * Everything here is a public fact: a chain id, a public RPC, a registry
 * address, and the id of the mandate this deployment features. There is no
 * MANDATE API base URL and no database connection string, because the page has
 * to be checkable by someone who does not trust the people who deployed it.
 *
 * The RPC and the registry are overridable by environment so a reader can point
 * the same page at their own endpoint. If MANDATE could only be verified
 * against infrastructure MANDATE controls, the verification would be worthless.
 */
import type { Address, Hex } from "viem";

export const CHAIN_ID = 97;
export const NETWORK_NAME = "BSC Testnet";

/** Verified reachable, and the same endpoint the CLI verifier defaults to. */
export const DEFAULT_RPC_URL = "https://bsc-testnet-rpc.publicnode.com";

/**
 * The live registry, matching `contracts/deployments/97.json`.
 *
 * The earlier deployment at `0x4c2b4d81…` is dead and its receipts are
 * abandoned. Pointing the page at it would keep rendering that run's evidence
 * as current, which is a quieter and worse failure than a page that cannot find
 * a mandate.
 */
export const RECEIPT_REGISTRY: Address = "0x0791af52629206b5434a6865e9e1536a493854ca";
export const IDENTITY_REGISTRY: Address = "0x8004a818bfb912233c491871b3d84c89a494bd9e";

/** The agent whose lifecycle this deployment publishes. */
export const FEATURED_AGENT = {
  agentId: "1842",
  name: "Conservative Guardian",
  identityRegistry: IDENTITY_REGISTRY,
} as const;

export const FEATURED_MANDATE_ID: Hex =
  "0x2392e1fcb2464cc390690f57dac7f46148b248fc15a9a4dfab0569fb4e598d1a";

/**
 * Where the run record lives.
 *
 * The evidence bundle and the disclosure are found through URIs the registry
 * stores, so this base is only used for the proof manifest, which the chain
 * never committed to. It is kept configurable rather than derived so a mirror
 * can serve it without the page pretending the mirror is authoritative.
 */
export const DEFAULT_EVIDENCE_BASE =
  "https://raw.githubusercontent.com/winsznx/mandate/main/artifacts/evidence/";

export const FEATURED_RUN_ID = "20260818T125522Z";

const EXPLORER_BASE = "https://testnet.bscscan.com";

export function explorerTxUrl(txHash: Hex): string {
  return `${EXPLORER_BASE}/tx/${txHash}`;
}

export function explorerAddressUrl(address: Address): string {
  return `${EXPLORER_BASE}/address/${address}`;
}

function envValue(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.length === 0 ? undefined : raw;
}

export function rpcUrl(): string {
  return envValue("MANDATE_RPC_URL") ?? DEFAULT_RPC_URL;
}

export function registryAddress(): Address {
  const override = envValue("MANDATE_REGISTRY_ADDRESS");
  return override === undefined ? RECEIPT_REGISTRY : (override.toLowerCase() as Address);
}

export function evidenceBase(): string {
  const base = envValue("MANDATE_EVIDENCE_BASE") ?? DEFAULT_EVIDENCE_BASE;
  return base.endsWith("/") ? base : `${base}/`;
}

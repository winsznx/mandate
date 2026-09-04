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

/**
 * The finished mandate this deployment publishes.
 *
 * It has to be one the *live* registry holds. An earlier id here named a run
 * that predated the lifecycle-event redeploy, so `getActivation` answered with
 * a zeroed struct and the proof page 404ed on its own headline link. Any change
 * to this constant should be checked against the registry before it lands: the
 * failure is silent from the outside and total from the inside.
 */
export const FEATURED_MANDATE_ID: Hex =
  "0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b";

export const FEATURED_RECEIPT_ID: Hex =
  "0x8c2f934fddaab41890260adec051df7795bf5a4e6dbd290515749ad76f286b76";

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

export const FEATURED_RUN_ID = "20260819T005008Z";

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

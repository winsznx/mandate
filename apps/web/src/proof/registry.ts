/**
 * Reading the receipt registry from the browser's side of the wall.
 *
 * The ABI is written out rather than imported from a Foundry artifact for the
 * same reason the CLI verifier writes it out: the page must be servable from a
 * checkout with no `forge build` behind it. Everything the proof rests on is
 * read here, from a contract with no owner, no pause and no upgrade path.
 */
import { deriveReceiptId } from "@mandate/domain";
import { createPublicClient, http } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { CHAIN_ID, rpcUrl } from "./config";

export const REGISTRY_ABI = [
  {
    name: "getReceipt",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "receiptId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
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
          { name: "publishedAt", type: "uint64" },
          { name: "evidenceURI", type: "string" },
        ],
      },
    ],
  },
  {
    name: "receiptExists",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "receiptId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "getActivation",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "mandateId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "trialReceiptId", type: "bytes32" },
          { name: "wallet", type: "address" },
          { name: "sessionKeyHash", type: "bytes32" },
          { name: "grantedAuthorityHash", type: "bytes32" },
          { name: "attestedBy", type: "address" },
          { name: "activatedAt", type: "uint64" },
          { name: "disclosureURI", type: "string" },
        ],
      },
    ],
  },
] as const;

export interface OnChainReceipt {
  identityRegistry: Address;
  agentId: bigint;
  agentVersionHash: Hex;
  trialSpecHash: Hex;
  testedAuthorityHash: Hex;
  scenarioHash: Hex;
  evaluatorHash: Hex;
  referenceModelHash: Hex;
  evidenceHash: Hex;
  snapshotBlock: bigint;
  createdAt: bigint;
  freshUntil: bigint;
  passed: boolean;
  publisher: Address;
  publishedAt: bigint;
  evidenceURI: string;
}

export interface OnChainActivation {
  trialReceiptId: Hex;
  wallet: Address;
  sessionKeyHash: Hex;
  grantedAuthorityHash: Hex;
  attestedBy: Address;
  activatedAt: bigint;
  disclosureURI: string;
}

/** The chain answered, but it does not know this id. Distinct from "the chain did not answer". */
export class UnknownMandateError extends Error {
  constructor(mandateId: Hex, registry: Address, chainId: number) {
    super(`no activation ${mandateId} in the registry at ${registry} on chain ${chainId}`);
    this.name = "UnknownMandateError";
  }
}

/** The endpoint failed. The reader is owed the endpoint and the underlying cause, not a blank page. */
export class ChainUnreachableError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string, detail: string) {
    super(detail);
    this.name = "ChainUnreachableError";
    this.endpoint = endpoint;
  }
}

export function publicClient(): PublicClient {
  // No chain object: every call here is a raw read, and pinning viem's chain
  // metadata would add a second place where the network could be misdescribed.
  return createPublicClient({ transport: http(rpcUrl(), { timeout: 15_000, retryCount: 1 }) });
}

/** Confirm the endpoint really is the chain it claims, before anything read from it is believed. */
export async function readChainId(client: PublicClient): Promise<number> {
  try {
    return await client.getChainId();
  } catch (error) {
    throw new ChainUnreachableError(rpcUrl(), `eth_chainId failed: ${describe(error)}`);
  }
}

export async function readActivation(
  client: PublicClient,
  params: { registry: Address; mandateId: Hex },
): Promise<OnChainActivation> {
  let activation: Awaited<ReturnType<typeof getActivation>>;
  try {
    activation = await getActivation(client, params);
  } catch (error) {
    throw new ChainUnreachableError(
      rpcUrl(),
      `the registry at ${params.registry} did not answer getActivation: ${describe(error)}`,
    );
  }

  // An unknown id returns a zeroed struct rather than reverting, so absence has
  // to be recognised from `activatedAt`.
  if (activation.activatedAt === 0n) {
    throw new UnknownMandateError(params.mandateId, params.registry, CHAIN_ID);
  }

  return {
    trialReceiptId: activation.trialReceiptId,
    wallet: activation.wallet.toLowerCase() as Address,
    sessionKeyHash: activation.sessionKeyHash,
    grantedAuthorityHash: activation.grantedAuthorityHash,
    attestedBy: activation.attestedBy.toLowerCase() as Address,
    activatedAt: activation.activatedAt,
    disclosureURI: activation.disclosureURI,
  };
}

function getActivation(client: PublicClient, params: { registry: Address; mandateId: Hex }) {
  return client.readContract({
    address: params.registry,
    abi: REGISTRY_ABI,
    functionName: "getActivation",
    args: [params.mandateId],
  });
}

export async function readReceipt(
  client: PublicClient,
  params: { registry: Address; receiptId: Hex },
): Promise<OnChainReceipt> {
  // `receiptExists` first: `getReceipt` reverts with a custom error on an
  // unknown id, and an RPC-level revert is indistinguishable from a wrong
  // registry address or a chain the contract was never deployed to.
  let exists: boolean;
  try {
    exists = await client.readContract({
      address: params.registry,
      abi: REGISTRY_ABI,
      functionName: "receiptExists",
      args: [params.receiptId],
    });
  } catch (error) {
    throw new ChainUnreachableError(
      rpcUrl(),
      `the registry at ${params.registry} did not answer receiptExists: ${describe(error)}`,
    );
  }

  if (!exists) {
    throw new UnknownMandateError(params.receiptId, params.registry, CHAIN_ID);
  }

  const stored = await client.readContract({
    address: params.registry,
    abi: REGISTRY_ABI,
    functionName: "getReceipt",
    args: [params.receiptId],
  });

  return {
    identityRegistry: stored.receipt.identityRegistry.toLowerCase() as Address,
    agentId: stored.receipt.agentId,
    agentVersionHash: stored.receipt.agentVersionHash,
    trialSpecHash: stored.receipt.trialSpecHash,
    testedAuthorityHash: stored.receipt.testedAuthorityHash,
    scenarioHash: stored.receipt.scenarioHash,
    evaluatorHash: stored.receipt.evaluatorHash,
    referenceModelHash: stored.receipt.referenceModelHash,
    evidenceHash: stored.receipt.evidenceHash,
    snapshotBlock: stored.receipt.snapshotBlock,
    createdAt: stored.receipt.createdAt,
    freshUntil: stored.receipt.freshUntil,
    passed: stored.receipt.passed,
    publisher: stored.publisher.toLowerCase() as Address,
    publishedAt: stored.publishedAt,
    evidenceURI: stored.evidenceURI,
  };
}

/**
 * Recompute the id from the fields that were read back.
 *
 * This is what makes the rest of the record load-bearing: the registry derives
 * ids from every field it commits to, so re-deriving the id here proves the
 * content behind the id is the content the id names.
 */
export function recomputeReceiptId(receipt: OnChainReceipt, chainId: number): Hex {
  return deriveReceiptId({
    chainId,
    publisher: receipt.publisher,
    identityRegistry: receipt.identityRegistry,
    agentId: receipt.agentId,
    agentVersionHash: receipt.agentVersionHash,
    trialSpecHash: receipt.trialSpecHash,
    testedAuthorityHash: receipt.testedAuthorityHash,
    scenarioHash: receipt.scenarioHash,
    evaluatorHash: receipt.evaluatorHash,
    referenceModelHash: receipt.referenceModelHash,
    evidenceHash: receipt.evidenceHash,
    snapshotBlock: receipt.snapshotBlock,
    createdAt: receipt.createdAt,
    freshUntil: receipt.freshUntil,
    passed: receipt.passed,
    evidenceURI: receipt.evidenceURI,
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.name;
  return String(error);
}

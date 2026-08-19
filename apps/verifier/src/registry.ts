/**
 * Reading the registry.
 *
 * This is the verifier's only source of truth. Every hash it later compares
 * against — the evidence commitment, the tested authority, the granted
 * authority, the session key — is read from here, from a contract with no
 * owner, no pause and no upgrade path. Nothing in this file consults a MANDATE
 * database, an API, or an indexer.
 *
 * The ABI is written out rather than imported from the Foundry artifact so the
 * verifier stays runnable from a checkout with no `forge build` behind it. A
 * judge should need a chain RPC and this repository, and nothing else.
 */
import { deriveReceiptId } from "@mandate/domain";
import type { Address, Hex, PublicClient } from "viem";

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
          { name: "validFrom", type: "uint64" },
          { name: "validUntil", type: "uint64" },
          { name: "revokedAt", type: "uint64" },
          { name: "disclosureURI", type: "string" },
        ],
      },
    ],
  },
  { name: "receiptCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    name: "receiptIdAt",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** A receipt exactly as the registry stores it, with no MANDATE-side interpretation applied. */
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
  /**
   * The window the session was granted over, committed at activation.
   *
   * This is what makes a finished mandate checkable. Once a session is revoked
   * the account holds no key, and an empty account is the same observation for
   * "revoked since activation" and "never granted at all". With the window on
   * chain the grant is reconstructible from the record itself, without archive
   * state and without trusting anyone's narration of it.
   */
  validFrom: bigint;
  validUntil: bigint;
  /** Zero while the registry holds no revocation for this mandate. */
  revokedAt: bigint;
  /**
   * Where the granted AuthorityIR can be fetched.
   *
   * Closes the gap that previously forced the subset step to SKIP: without it
   * the on-chain hash let a verifier CHECK a document it was handed but never
   * OBTAIN one, so a judge working from chain alone could not evaluate the
   * relation at all. The hash is still what is trusted.
   */
  disclosureURI: string;
}

export class UnknownReceiptError extends Error {
  constructor(receiptId: Hex, registry: Address, chainId: number) {
    super(`no receipt ${receiptId} in the registry at ${registry} on chain ${chainId}`);
    this.name = "UnknownReceiptError";
  }
}

export class UnknownMandateError extends Error {
  constructor(mandateId: Hex, registry: Address, chainId: number) {
    super(`no activation ${mandateId} in the registry at ${registry} on chain ${chainId}`);
    this.name = "UnknownMandateError";
  }
}

export async function readReceipt(
  client: PublicClient,
  params: { registry: Address; receiptId: Hex; chainId: number },
): Promise<OnChainReceipt> {
  // `receiptExists` first, because `getReceipt` reverts with a custom error on
  // an unknown id and an RPC-level revert is indistinguishable from a wrong
  // registry address or a chain the contract was never deployed to.
  const exists = await client
    .readContract({
      address: params.registry,
      abi: REGISTRY_ABI,
      functionName: "receiptExists",
      args: [params.receiptId],
    })
    .catch((error: unknown) => {
      throw new Error(
        `the registry at ${params.registry} on chain ${params.chainId} did not answer receiptExists: ${String(error)}`,
      );
    });

  if (!exists) throw new UnknownReceiptError(params.receiptId, params.registry, params.chainId);

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

export async function readActivation(
  client: PublicClient,
  params: { registry: Address; mandateId: Hex; chainId: number },
): Promise<OnChainActivation> {
  const activation = await client
    .readContract({
      address: params.registry,
      abi: REGISTRY_ABI,
      functionName: "getActivation",
      args: [params.mandateId],
    })
    .catch((error: unknown) => {
      throw new Error(
        `the registry at ${params.registry} on chain ${params.chainId} did not answer getActivation: ${String(error)}`,
      );
    });

  // `getActivation` returns a zeroed struct for an unknown id rather than
  // reverting, so absence has to be recognised from `activatedAt`.
  if (activation.activatedAt === 0n) {
    throw new UnknownMandateError(params.mandateId, params.registry, params.chainId);
  }

  return {
    trialReceiptId: activation.trialReceiptId,
    wallet: activation.wallet.toLowerCase() as Address,
    sessionKeyHash: activation.sessionKeyHash,
    grantedAuthorityHash: activation.grantedAuthorityHash,
    attestedBy: activation.attestedBy.toLowerCase() as Address,
    activatedAt: activation.activatedAt,
    validFrom: activation.validFrom,
    validUntil: activation.validUntil,
    revokedAt: activation.revokedAt,
    disclosureURI: activation.disclosureURI,
  };
}

/**
 * Recompute the id from the stored fields.
 *
 * This is the check that makes the rest of the record load-bearing. The
 * registry derives ids from every field it commits to, including the chain and
 * the publisher, so re-deriving it in TypeScript from what was read back proves
 * that the content behind the id is the content the id names — and that the
 * TypeScript and Solidity derivations still agree, which is what
 * `contracts/test/ScopeHashLib.t.sol` pins in the other direction.
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

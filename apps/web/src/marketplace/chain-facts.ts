/**
 * What the chain says about an agent, asked softly.
 *
 * The proof page reads the registry and throws when a record is missing,
 * because a proof page with a missing record has nothing to show. A listing
 * page is the opposite: "this agent has no receipt in the live registry" is
 * ordinary and has to render, so every read here resolves to a described
 * outcome instead of an exception.
 *
 * Three outcomes, never two. `CONFIRMED` and `ABSENT` are answers from a
 * registry that replied; `UNREADABLE` means nobody answered. Collapsing the
 * third into the second would let an RPC outage silently demote every agent on
 * the page, which is exactly the kind of quiet lie this product exists to stop.
 */
import { cache } from "react";
import type { Address, Hex } from "viem";
import { IDENTITY_REGISTRY, registryAddress, rpcUrl } from "../proof/config";
import { publicClient, readActivation, readReceipt } from "../proof/registry";

export type Observed = "CONFIRMED" | "ABSENT" | "UNREADABLE";

const IDENTITY_ABI = [
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

export interface IdentityFact {
  observed: Observed;
  /** The URI the ERC-8004 registration points at. This is what makes a card checkable. */
  registrationUri: string | undefined;
  owner: Address | undefined;
  reason: string | undefined;
}

/**
 * The registration behind an agent id.
 *
 * The registration URI is the load-bearing part: an agent card that the
 * identity registry points at is a public commitment, and one that merely sits
 * in a repository is a file. The interface distinguishes them.
 */
export const readIdentity = cache(async (agentId: string): Promise<IdentityFact> => {
  const client = publicClient();
  let tokenId: bigint;
  try {
    tokenId = BigInt(agentId);
  } catch {
    return { observed: "ABSENT", registrationUri: undefined, owner: undefined, reason: "the agent id is not a number" };
  }

  try {
    const [registrationUri, owner] = await Promise.all([
      client.readContract({
        address: IDENTITY_REGISTRY,
        abi: IDENTITY_ABI,
        functionName: "tokenURI",
        args: [tokenId],
      }),
      client.readContract({
        address: IDENTITY_REGISTRY,
        abi: IDENTITY_ABI,
        functionName: "ownerOf",
        args: [tokenId],
      }),
    ]);
    return {
      observed: "CONFIRMED",
      registrationUri: registrationUri.length === 0 ? undefined : registrationUri,
      owner: owner.toLowerCase() as Address,
      reason: undefined,
    };
  } catch (error) {
    return {
      observed: "UNREADABLE",
      registrationUri: undefined,
      owner: undefined,
      reason: `the identity registry at ${IDENTITY_REGISTRY} did not answer for #${agentId}: ${describe(error)}`,
    };
  }
});

export interface ReceiptFact {
  observed: Observed;
  receiptId: Hex | undefined;
  passed: boolean;
  freshUntil: number;
  agentVersionHash: Hex | undefined;
  testedAuthorityHash: Hex | undefined;
  reason: string | undefined;
}

const ABSENT_RECEIPT: ReceiptFact = {
  observed: "ABSENT",
  receiptId: undefined,
  passed: false,
  freshUntil: 0,
  agentVersionHash: undefined,
  testedAuthorityHash: undefined,
  reason: undefined,
};

/** Is this run's receipt actually in the registry the deployment record names? */
export const readReceiptFact = cache(async (receiptId: Hex): Promise<ReceiptFact> => {
  try {
    const receipt = await readReceipt(publicClient(), { registry: registryAddress(), receiptId });
    return {
      observed: "CONFIRMED",
      receiptId,
      passed: receipt.passed,
      freshUntil: Number(receipt.freshUntil),
      agentVersionHash: receipt.agentVersionHash,
      testedAuthorityHash: receipt.testedAuthorityHash,
      reason: undefined,
    };
  } catch (error) {
    if (isUnknownRecord(error)) return { ...ABSENT_RECEIPT, receiptId };
    return {
      ...ABSENT_RECEIPT,
      observed: "UNREADABLE",
      receiptId,
      reason: `${rpcUrl()} did not answer for receipt ${receiptId}: ${describe(error)}`,
    };
  }
});

export interface ActivationFact {
  observed: Observed;
  mandateId: Hex | undefined;
  trialReceiptId: Hex | undefined;
  validFrom: number;
  validUntil: number;
  revokedAt: number;
  reason: string | undefined;
}

const ABSENT_ACTIVATION: ActivationFact = {
  observed: "ABSENT",
  mandateId: undefined,
  trialReceiptId: undefined,
  validFrom: 0,
  validUntil: 0,
  revokedAt: 0,
  reason: undefined,
};

/** Did this run's mandate really activate, and has it been revoked since? */
export const readActivationFact = cache(async (mandateId: Hex): Promise<ActivationFact> => {
  try {
    const activation = await readActivation(publicClient(), { registry: registryAddress(), mandateId });
    return {
      observed: "CONFIRMED",
      mandateId,
      trialReceiptId: activation.trialReceiptId,
      validFrom: Number(activation.validFrom),
      validUntil: Number(activation.validUntil),
      revokedAt: Number(activation.revokedAt),
      reason: undefined,
    };
  } catch (error) {
    if (isUnknownRecord(error)) return { ...ABSENT_ACTIVATION, mandateId };
    return {
      ...ABSENT_ACTIVATION,
      observed: "UNREADABLE",
      mandateId,
      reason: `${rpcUrl()} did not answer for mandate ${mandateId}: ${describe(error)}`,
    };
  }
});

/** The chain answered and said it holds no such record. */
function isUnknownRecord(error: unknown): boolean {
  return error instanceof Error && error.name === "UnknownMandateError";
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.name;
  return String(error);
}

/**
 * Deterministic identifiers.
 *
 * Receipt and mandate ids are derived from `abi.encode` rather than from the
 * canonical JSON encoding, because Solidity has to reproduce them. Every field
 * that changes what a receipt means is in the preimage, including the chain id
 * and the publisher, so a receipt cannot be replayed onto another chain or
 * re-attributed to another publisher.
 */
import { encodeAbiParameters, keccak256, stringToHex } from "viem";
import type { Address, Hex } from "viem";
import type { TrialReceipt } from "./schemas/trial-receipt.js";

/** Domain separators. Distinct constants stop one id family from colliding with another. */
export const RECEIPT_ID_DOMAIN: Hex = keccak256(stringToHex("mandate.receipt-id/1"));
export const MANDATE_ID_DOMAIN: Hex = keccak256(stringToHex("mandate.mandate-id/1"));

export interface ReceiptIdInput {
  chainId: number;
  publisher: Address;
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
  evidenceURI: string;
}

/**
 * Derive a receipt id.
 *
 * `evidenceURI` enters as a hash of its bytes so the preimage stays fixed-width
 * and matches what Solidity can compute cheaply. Mirrored by
 * `ScopeHashLib.receiptId` — `contracts/test/ScopeHashLib.t.sol` asserts the two
 * agree on the shared golden vectors.
 */
export function deriveReceiptId(input: ReceiptIdInput): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" }, // domain
      { type: "uint256" }, // chainId
      { type: "address" }, // publisher
      { type: "address" }, // identityRegistry
      { type: "uint256" }, // agentId
      { type: "bytes32" }, // agentVersionHash
      { type: "bytes32" }, // trialSpecHash
      { type: "bytes32" }, // testedAuthorityHash
      { type: "bytes32" }, // scenarioHash
      { type: "bytes32" }, // evaluatorHash
      { type: "bytes32" }, // referenceModelHash
      { type: "bytes32" }, // evidenceHash
      { type: "uint64" }, // snapshotBlock
      { type: "uint64" }, // createdAt
      { type: "uint64" }, // freshUntil
      { type: "bool" }, // passed
      { type: "bytes32" }, // keccak256(evidenceURI)
    ],
    [
      RECEIPT_ID_DOMAIN,
      BigInt(input.chainId),
      input.publisher,
      input.identityRegistry,
      input.agentId,
      input.agentVersionHash,
      input.trialSpecHash,
      input.testedAuthorityHash,
      input.scenarioHash,
      input.evaluatorHash,
      input.referenceModelHash,
      input.evidenceHash,
      input.snapshotBlock,
      input.createdAt,
      input.freshUntil,
      input.passed,
      keccak256(stringToHex(input.evidenceURI)),
    ],
  );
  return keccak256(encoded);
}

/** Derive a receipt id straight from a validated receipt document. */
export function receiptIdOf(receipt: TrialReceipt): Hex {
  return deriveReceiptId({
    chainId: receipt.chainId,
    publisher: receipt.publisher,
    identityRegistry: receipt.identityRegistry,
    agentId: BigInt(receipt.agentId),
    agentVersionHash: receipt.agentVersionHash,
    trialSpecHash: receipt.trialSpecHash,
    testedAuthorityHash: receipt.testedAuthorityHash,
    scenarioHash: receipt.scenarioHash,
    evaluatorHash: receipt.evaluatorHash,
    referenceModelHash: receipt.referenceModelHash,
    evidenceHash: receipt.evidenceHash,
    snapshotBlock: BigInt(receipt.snapshotBlock),
    createdAt: BigInt(receipt.createdAt),
    freshUntil: BigInt(receipt.freshUntil),
    passed: receipt.result === "PASS",
    evidenceURI: receipt.evidenceURI,
  });
}

export interface MandateIdInput {
  chainId: number;
  wallet: Address;
  trialReceiptId: Hex;
  grantedAuthorityHash: Hex;
  /** Increments on renewal so each renewal is a new mandate rather than a mutation of the old one. */
  sequence: number;
}

export function deriveMandateId(input: MandateIdInput): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint32" },
    ],
    [
      MANDATE_ID_DOMAIN,
      BigInt(input.chainId),
      input.wallet,
      input.trialReceiptId,
      input.grantedAuthorityHash,
      input.sequence,
    ],
  );
  return keccak256(encoded);
}

/**
 * Short human-facing label for a mandate, e.g. `M-4f2a91`.
 *
 * Display only. Nothing resolves a mandate by this string.
 */
export function shortMandateLabel(mandateId: Hex): string {
  return `M-${mandateId.slice(2, 8)}`;
}

/**
 * Session key identifiers.
 *
 * There are two of them and they are not interchangeable. Mixing them up
 * produces lookups that silently return empty rather than failing, which is the
 * worst possible failure mode for an authority reader: an empty permission set
 * reads as "this session can do nothing" when it may in fact do a great deal.
 *
 *   keyId   — how the public KeyStore registry indexes the key.
 *             keccak256(SEC1 uncompressed public key, 65 bytes)
 *
 *   keyHash — how the account contract indexes the key's permissions.
 *             keccak256(abi.encode(uint256(keyType), keccak256(abi.encode(address))))
 *
 * The SDK computes both internally but exports neither through its `exports`
 * map, so they are reimplemented here against the published formula and pinned
 * by tests.
 */
import { encodeAbiParameters, keccak256 } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import type { Address, Hex } from "viem";
import { KEY_TYPE } from "./constants.js";

/**
 * The account's key hash for a Secp256k1 session key.
 *
 * The account stores a Secp256k1 key as its 20-byte address left-padded to a
 * word, so the hash is taken over the address rather than the public key. This
 * is why it differs from the KeyStore's `keyId`.
 */
export function accountKeyHash(signerAddress: Address): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }], [signerAddress]));
  return keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [BigInt(KEY_TYPE.Secp256k1), inner]),
  );
}

/**
 * The public KeyStore's identifier for a key.
 *
 * Taken over the raw SEC1 uncompressed public key (65 bytes, `0x04` prefix),
 * not over the address.
 */
export function keyStoreKeyId(publicKey: Hex): Hex {
  const byteLength = (publicKey.length - 2) / 2;
  if (byteLength !== 65) {
    throw new Error(
      `KeyStore keyId requires a 65-byte SEC1 uncompressed public key, received ${byteLength} bytes`,
    );
  }
  return keccak256(publicKey);
}

/** Both identifiers for one session key, so callers cannot derive only the convenient one. */
export interface SessionKeyIdentity {
  publicKey: Hex;
  signerAddress: Address;
  /** Index in the account's permission storage. */
  keyHash: Hex;
  /** Index in the public KeyStore registry. */
  keyId: Hex;
}

export function sessionKeyIdentity(publicKey: Hex): SessionKeyIdentity {
  const signerAddress = publicKeyToAddress(publicKey);
  return {
    publicKey,
    signerAddress,
    keyHash: accountKeyHash(signerAddress),
    keyId: keyStoreKeyId(publicKey),
  };
}

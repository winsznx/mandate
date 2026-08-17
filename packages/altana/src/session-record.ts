/**
 * Persisting a session without breaking it, and without storing a key.
 *
 * Two independent hazards meet in this file.
 *
 * The first is correctness. A session's `permissions` and `expiry` are hashed
 * into the key hash the account stores. `JSON.stringify` throws on the `bigint`
 * spend limits, and the obvious fix — coercing them to `Number` — silently
 * rounds any cap above 2^53. A 25-USDT cap on BSC is 25e18 base units, so the
 * obvious fix is wrong for the very first value MANDATE will ever persist, and
 * the resulting session is bricked with no error at write time.
 *
 * The second is secrecy. A `Session` carries its signer, and the signer carries
 * a private key. That value must never reach a database column, a log line, an
 * evidence artifact or an analytics event. So the persisted record is defined
 * as a separate type that structurally cannot hold one, rather than as the
 * session with a field deleted.
 */
import { canonicalHash } from "@mandate/domain/canonical";
import type { SpendPeriod } from "@mandate/domain";
import type { Address, Hex } from "viem";
import type { RequestedSessionPermissions } from "./effective-authority.js";

/**
 * The publicly disclosable part of a session.
 *
 * Everything here appears on the proof page. There is no field a private key
 * could occupy.
 */
export interface SessionRecord {
  chainId: number;
  walletAddress: Address;
  /** SEC1 uncompressed public key of the session signer. */
  publicKey: Hex;
  /** Index in the account's permission storage. */
  keyHash: Hex;
  /** Index in the public KeyStore registry. */
  keyId: Hex;
  /** What was requested, with spend limits as decimal strings. Not what is enforced. */
  requestedPermissions: SerializedPermissions;
  expiry: number;
  grantTxHash?: Hex;
  revokeTxHash?: Hex;
}

export interface SerializedCallPermission {
  to?: Address;
  signature?: string;
}

export interface SerializedSpendPermission {
  /** Decimal string. Never a JSON number: a BSC stablecoin cap exceeds 2^53. */
  limit: string;
  period: SpendPeriod;
  token?: Address;
}

export interface SerializedPermissions {
  calls: SerializedCallPermission[];
  spend: SerializedSpendPermission[];
}

/** Convert requested permissions into their lossless persisted form. */
export function serializePermissions(
  permissions: RequestedSessionPermissions,
): SerializedPermissions {
  return {
    calls: (permissions.calls ?? []).map((call) => {
      const serialized: SerializedCallPermission = {};
      if ("to" in call) serialized.to = call.to.toLowerCase() as Address;
      if ("signature" in call) serialized.signature = call.signature;
      return serialized;
    }),
    spend: (permissions.spend ?? []).map((entry) => {
      const serialized: SerializedSpendPermission = {
        limit: entry.limit.toString(10),
        period: entry.period,
      };
      if (entry.token !== undefined) serialized.token = entry.token.toLowerCase() as Address;
      return serialized;
    }),
  };
}

/**
 * Restore permissions in the shape the SDK expects.
 *
 * `BigInt(limit)` throws on a malformed string rather than producing `NaN`,
 * which is the behaviour worth having: a corrupted record should fail loudly at
 * load rather than quietly grant a different cap.
 */
export function deserializePermissions(
  permissions: SerializedPermissions,
): RequestedSessionPermissions {
  return {
    calls: permissions.calls.map((call) => {
      if (call.to !== undefined && call.signature !== undefined) {
        return { to: call.to, signature: call.signature };
      }
      if (call.to !== undefined) return { to: call.to };
      if (call.signature !== undefined) return { signature: call.signature };
      throw new Error("A call permission must carry a target, a signature, or both");
    }),
    spend: permissions.spend.map((entry) => {
      const restored: { limit: bigint; period: SpendPeriod; token?: Address } = {
        limit: BigInt(entry.limit),
        period: entry.period,
      };
      if (entry.token !== undefined) restored.token = entry.token;
      return restored;
    }),
  };
}

/**
 * Canonical hash of the requested permissions plus expiry.
 *
 * Committed publicly so a verifier can confirm that the permissions MANDATE
 * says it requested are the ones it did request. It says nothing about what is
 * enforced — that comes from the chain, and the two are compared rather than
 * assumed equal.
 */
export function requestedPermissionsHash(record: {
  chainId: number;
  walletAddress: Address;
  publicKey: Hex;
  requestedPermissions: SerializedPermissions;
  expiry: number;
}): Hex {
  return canonicalHash({
    chainId: record.chainId,
    wallet: record.walletAddress.toLowerCase(),
    publicKey: record.publicKey.toLowerCase(),
    expiry: record.expiry,
    calls: record.requestedPermissions.calls.map((call) => ({
      to: call.to ?? null,
      signature: call.signature ?? null,
    })),
    spend: record.requestedPermissions.spend.map((entry) => ({
      token: entry.token ?? null,
      limit: entry.limit,
      period: entry.period,
    })),
  });
}

/** Field names that must never appear in a persisted session or a log line. */
const FORBIDDEN_KEYS = ["privatekey", "privkey", "secretkey", "mnemonic", "seed", "signer"];

/**
 * Assert that a value carries no key material before it is written anywhere.
 *
 * A guard rather than a convention, because the failure is silent, permanent
 * and catastrophic: a private key in a database column stays there, and nothing
 * about the system behaves differently until it is exploited.
 */
export function assertNoKeyMaterial(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoKeyMaterial(item, `${path}[${index}]`));
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) {
      throw new Error(`Refusing to persist key material: ${path}.${key}`);
    }
    assertNoKeyMaterial(nested, `${path}.${key}`);
  }
}

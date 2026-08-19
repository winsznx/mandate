/**
 * Who is who in a proof run.
 *
 * Until this existed one key played every part: it held the Venus position, it
 * granted the session, it received the session, and it published the receipt.
 * The enforcement evidence survived that — holding both sides of a grant cannot
 * make an account permit a call it would otherwise refuse — but the trust story
 * did not, because a reader asking "so you gave yourself permission and then
 * obeyed it?" was told yes.
 *
 * Three roles are named here and kept apart:
 *
 *   OWNER      holds the Venus position and the wallet's admin authority. It
 *              grants the session and it revokes the session. This is the
 *              capital owner, and unilateral revocation is the property a
 *              capital owner actually cares about.
 *   AGENT      receives the session and signs every execution attempted under
 *              it. Its key is supplied out of band and the owner never holds it.
 *   PUBLISHER  publishes receipts and records activations. Currently the owner,
 *              declared as such rather than left to be inferred from two
 *              addresses that happen to match.
 *
 * The session key is not the agent's identity key. Altana's KeyStore revocation
 * is monotonic, so a keyId that has been revoked can never be registered again
 * and a run that reused one long-lived key would work exactly once. Each run
 * therefore acts under a fresh session key derived from the agent's identity
 * key, and the agent signs a designation naming it. That signature is what makes
 * the pairing checkable: the owner cannot produce it, so a reader can confirm
 * from the manifest alone that the key which signed the executions was chosen by
 * the agent and not by the party that granted it.
 */
import { encodeAbiParameters, keccak256, recoverMessageAddress } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalize } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";

export const SESSION_KEY_DESIGNATION_SCHEMA_VERSION = "mandate.session-key-designation/1" as const;

export const ROLE_NAMES = ["owner", "agent", "publisher"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** What the agent signs to name the key it will act under for one run. */
export interface SessionKeyDesignation {
  schemaVersion: typeof SESSION_KEY_DESIGNATION_SCHEMA_VERSION;
  chainId: number;
  runId: string;
  /** The agent's long-lived identity address. Recovers from the signature. */
  agent: Address;
  /** The address that will sign this run's executions. */
  sessionKey: Address;
}

/**
 * The addresses a run publishes, and nothing else.
 *
 * Deliberately a separate type from the signers. Everything the manifest shows
 * is in here, so no code path can serialize a structure that also carries key
 * material.
 */
export interface RoleAddresses {
  owner: Address;
  agent: Address;
  publisher: Address;
  /**
   * The role the publisher currently doubles as, or `"none"` when it is an
   * independent party. An alias that is declared is a disclosure; one that is
   * merely true is a coincidence a reader has to spot for themselves.
   */
  publisherSameAs: RoleName | "none";
  /** The per-run key the agent designated. Distinct from the agent's identity. */
  sessionKey: Address;
  designation: SessionKeyDesignation;
  /** EIP-191 signature over the canonical designation, by the agent's identity key. */
  designationSignature: Hex;
}

export interface ResolvedRoles {
  addresses: RoleAddresses;
  /** The owner's admin key. Never leaves this object. */
  ownerPrivateKey: Hex;
  /** This run's session key, derived from the agent's identity key. Never leaves this object. */
  sessionPrivateKey: Hex;
}

/** Two roles found sharing one address. */
export interface RoleCollision {
  left: RoleName;
  right: RoleName;
  address: Address;
}

function designationBytes(designation: SessionKeyDesignation): string {
  return canonicalize(designation as unknown as CanonicalValue);
}

/**
 * This run's session private key.
 *
 * Keyed on the agent's identity key, so only the agent can compute it, and
 * salted with the run id and chain so every run gets a key that has never been
 * registered before. Deterministic on purpose: an agent that lost the process
 * mid-run can re-derive the exact key its session was granted to rather than
 * being locked out of a live mandate.
 *
 * A derived value at or above the secp256k1 order is roughly a 2^-128 event and
 * is left to surface as a throw from `privateKeyToAccount`. That happens during
 * preflight, before any write, so the failure mode is a run that refuses to
 * start rather than a run that quietly falls back to a weaker key.
 */
export function deriveSessionPrivateKey(
  agentPrivateKey: Hex,
  params: { chainId: number; runId: string },
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint256" }, { type: "string" }],
      [
        SESSION_KEY_DESIGNATION_SCHEMA_VERSION,
        agentPrivateKey,
        BigInt(params.chainId),
        params.runId,
      ],
    ),
  );
}

export function designationFor(params: {
  chainId: number;
  runId: string;
  agent: Address;
  sessionKey: Address;
}): SessionKeyDesignation {
  return {
    schemaVersion: SESSION_KEY_DESIGNATION_SCHEMA_VERSION,
    chainId: params.chainId,
    runId: params.runId,
    agent: params.agent,
    sessionKey: params.sessionKey,
  };
}

/** The address that signed a designation, for a reader checking the manifest. */
export async function recoverDesignationSigner(
  designation: SessionKeyDesignation,
  signature: Hex,
): Promise<Address> {
  const recovered = await recoverMessageAddress({
    message: designationBytes(designation),
    signature,
  });
  return recovered.toLowerCase() as Address;
}

/**
 * Resolve the run's parties from the two keys the operator supplies.
 *
 * The agent's identity key signs the designation here and is not used again:
 * everything downstream acts under the derived session key, which is what the
 * owner grants to and what the account enforces against.
 */
export async function resolveRoles(params: {
  ownerPrivateKey: Hex;
  agentPrivateKey: Hex;
  chainId: number;
  runId: string;
}): Promise<ResolvedRoles> {
  const owner = privateKeyToAccount(params.ownerPrivateKey).address.toLowerCase() as Address;
  const agentAccount = privateKeyToAccount(params.agentPrivateKey);
  const agent = agentAccount.address.toLowerCase() as Address;

  const sessionPrivateKey = deriveSessionPrivateKey(params.agentPrivateKey, {
    chainId: params.chainId,
    runId: params.runId,
  });
  const sessionKey = privateKeyToAccount(sessionPrivateKey).address.toLowerCase() as Address;

  const designation = designationFor({
    chainId: params.chainId,
    runId: params.runId,
    agent,
    sessionKey,
  });
  const designationSignature = await agentAccount.signMessage({
    message: designationBytes(designation),
  });

  return {
    addresses: {
      owner,
      agent,
      // The owner publishes for now. The field exists so an independent
      // publisher is a configuration change rather than a schema change.
      publisher: owner,
      publisherSameAs: "owner",
      sessionKey,
      designation,
      designationSignature,
    },
    ownerPrivateKey: params.ownerPrivateKey,
    sessionPrivateKey,
  };
}

/**
 * Every pair of roles that shares an address without saying so.
 *
 * A declared alias — the publisher currently being the owner — is a disclosure
 * and is not reported. Anything else is role collapse, and the whole point of
 * this module is that it can never happen silently again.
 */
export function undeclaredCollisions(addresses: RoleAddresses): RoleCollision[] {
  const held: Record<RoleName, Address> = {
    owner: addresses.owner,
    agent: addresses.agent,
    publisher: addresses.publisher,
  };
  const declared = new Set<string>(
    addresses.publisherSameAs === "none" ? [] : [pairKey("publisher", addresses.publisherSameAs)],
  );

  const collisions: RoleCollision[] = [];
  for (let i = 0; i < ROLE_NAMES.length; i += 1) {
    for (let j = i + 1; j < ROLE_NAMES.length; j += 1) {
      const left = ROLE_NAMES[i] as RoleName;
      const right = ROLE_NAMES[j] as RoleName;
      if (held[left] !== held[right]) continue;
      if (declared.has(pairKey(left, right))) continue;
      collisions.push({ left, right, address: held[left] });
    }
  }
  return collisions;
}

function pairKey(left: RoleName, right: RoleName): string {
  return [left, right].sort().join("|");
}

/**
 * The role block the manifest publishes.
 *
 * Every address in here is checkable against the chain without trusting this
 * document: the owner is the sender of the grant, the approval and the registry
 * writes; the session key is committed to by the activation's `sessionKeyHash`,
 * which is `keccak256(abi.encode(uint256(keyType), keccak256(abi.encode(address))))`;
 * and the agent identity recovers from `designationSignature`. A manifest that
 * named different parties than the ones that acted would contradict the chain
 * rather than merely be unverifiable.
 */
export function roleRecord(addresses: RoleAddresses): CanonicalValue {
  const collisions = undeclaredCollisions(addresses);
  return {
    owner: {
      address: addresses.owner,
      holds: "the Venus position and the wallet's admin authority",
      grants: "the session, and revokes it unilaterally",
    },
    agent: {
      address: addresses.agent,
      holds: "the session key this run acts under; never the wallet's admin authority",
      sessionKey: addresses.sessionKey,
      designation: { ...addresses.designation } as unknown as CanonicalValue,
      designationSignature: addresses.designationSignature,
      designationNote:
        "EIP-191 over the canonical designation. Recovering it yields the agent address, which the owner could not have produced, so the key that signed this run's executions was chosen by the agent.",
    },
    publisher: {
      address: addresses.publisher,
      holds: "publication of the trial receipt and the activation and revocation records",
      sameAs: addresses.publisherSameAs,
      note:
        addresses.publisherSameAs === "none"
          ? "an independent publisher"
          : `the ${addresses.publisherSameAs} publishes for now; this is disclosed rather than claimed to be a third party`,
    },
    separation: {
      ownerIsAgent: addresses.owner === addresses.agent,
      agentIsPublisher: addresses.agent === addresses.publisher,
      publisherIsOwner: addresses.publisher === addresses.owner,
      undeclaredCollisions: collisions.map((collision) => ({
        left: collision.left,
        right: collision.right,
        address: collision.address,
      })),
      assertion:
        "The owner and the agent are different keys. The owner granted the session; the agent signed every execution attempted under it.",
    },
  };
}

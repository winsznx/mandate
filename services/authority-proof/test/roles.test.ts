import { describe, expect, it } from "vitest";
import { canonicalize } from "@mandate/domain";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  deriveSessionPrivateKey,
  recoverDesignationSigner,
  resolveRoles,
  roleRecord,
  undeclaredCollisions,
  type RoleAddresses,
} from "../src/phase7/roles.js";

/** Synthetic keys. Nothing on any chain holds these; they exist to be compared. */
const OWNER_KEY = `0x${"11".repeat(32)}` as Hex;
const AGENT_KEY = `0x${"22".repeat(32)}` as Hex;
const OTHER_AGENT_KEY = `0x${"33".repeat(32)}` as Hex;

const RUN = { chainId: 97, runId: "20260819T044000Z" } as const;

async function roles(agentKey: Hex = AGENT_KEY, runId: string = RUN.runId) {
  return resolveRoles({
    ownerPrivateKey: OWNER_KEY,
    agentPrivateKey: agentKey,
    chainId: RUN.chainId,
    runId,
  });
}

describe("the run's parties", () => {
  it("gives the agent a session key the owner's key cannot produce", async () => {
    // #given an owner and an agent holding different keys
    const resolved = await roles();

    // #when the run's session key is derived
    const { owner, agent, sessionKey } = resolved.addresses;

    // #then no two of the three are the same address. This is the property the
    // whole proof rests on: one party granted, another acted.
    expect(new Set([owner, agent, sessionKey]).size).toBe(3);
    expect(deriveSessionPrivateKey(OWNER_KEY, RUN)).not.toBe(resolved.sessionPrivateKey);
  });

  it("derives the session key from the agent's key alone, deterministically", async () => {
    // #given the same agent key and the same run
    const first = await roles();
    const second = await roles();

    // #then the agent can re-derive the exact key its session was granted to,
    // which is what lets an agent that lost its process rejoin a live mandate
    expect(second.sessionPrivateKey).toBe(first.sessionPrivateKey);

    // #when either the agent or the run changes
    const otherAgent = await roles(OTHER_AGENT_KEY);
    const otherRun = await roles(AGENT_KEY, "20260820T044000Z");

    // #then the key changes too. Altana's KeyStore revocation is monotonic, so
    // a run that reused one key would work exactly once.
    expect(otherAgent.sessionPrivateKey).not.toBe(first.sessionPrivateKey);
    expect(otherRun.sessionPrivateKey).not.toBe(first.sessionPrivateKey);
  });

  it("lets a reader recover the agent from the designation, so the pairing is checkable", async () => {
    // #given a designation signed by the agent's identity key
    const { addresses } = await roles();

    // #when a reader with only the manifest recovers the signer
    const recovered = await recoverDesignationSigner(
      addresses.designation,
      addresses.designationSignature,
    );

    // #then it is the agent. The owner could not have produced this signature,
    // so the key that signed the executions was chosen by the agent.
    expect(recovered).toBe(addresses.agent);
    expect(addresses.designation.sessionKey).toBe(addresses.sessionKey);
    expect(addresses.designation.chainId).toBe(RUN.chainId);
    expect(addresses.designation.runId).toBe(RUN.runId);
  });

  it("names the owner as the publisher rather than leaving two matching addresses to be spotted", async () => {
    // #given the current arrangement, where the owner publishes
    const { addresses } = await roles();

    // #then the alias is declared, and declaring it is what keeps it from
    // reading as an accident
    expect(addresses.publisher).toBe(addresses.owner);
    expect(addresses.publisherSameAs).toBe("owner");
    expect(undeclaredCollisions(addresses)).toEqual([]);
  });
});

describe("the collision check", () => {
  const base: RoleAddresses = {
    owner: "0x1111111111111111111111111111111111111111",
    agent: "0x2222222222222222222222222222222222222222",
    publisher: "0x1111111111111111111111111111111111111111",
    publisherSameAs: "owner",
    sessionKey: "0x3333333333333333333333333333333333333333",
    designation: {
      schemaVersion: "mandate.session-key-designation/1",
      chainId: 97,
      runId: RUN.runId,
      agent: "0x2222222222222222222222222222222222222222",
      sessionKey: "0x3333333333333333333333333333333333333333",
    },
    designationSignature: `0x${"ab".repeat(65)}` as Hex,
  };

  it("catches the owner playing the agent", () => {
    // #given a run configured with one key for both parties
    const collapsed: RoleAddresses = { ...base, agent: base.owner };

    // #when the roles are compared
    const collisions = undeclaredCollisions(collapsed);

    // #then it is reported, because this is the exact regression the module
    // exists to make impossible to ship silently
    expect(collisions).toHaveLength(2);
    expect(collisions.map((collision) => `${collision.left}/${collision.right}`)).toContain(
      "owner/agent",
    );
  });

  it("catches the agent publishing its own receipts", () => {
    // #given a publisher declared as the owner but actually holding the agent's key
    const collapsed: RoleAddresses = { ...base, publisher: base.agent };

    // #when the roles are compared
    const collisions = undeclaredCollisions(collapsed);

    // #then the declared alias does not excuse it: what was declared was
    // publisher = owner, and this is not that
    expect(collisions).toEqual([
      { left: "agent", right: "publisher", address: base.agent },
    ]);
  });
});

describe("the published role record", () => {
  it("carries no key material", async () => {
    // #given the record the manifest publishes
    const resolved = await roles();
    const encoded = canonicalize(roleRecord(resolved.addresses));

    // #then neither key appears in it, in either case. A manifest is a public
    // document and a leaked key cannot be unpublished.
    for (const key of [OWNER_KEY, AGENT_KEY, resolved.sessionPrivateKey]) {
      expect(encoded).not.toContain(key);
      expect(encoded).not.toContain(key.slice(2));
      expect(encoded.toLowerCase()).not.toContain(key.slice(2).toLowerCase());
    }
  });

  it("states the separation as a fact a reader can check against the chain", async () => {
    // #given the record
    const resolved = await roles();
    const record = roleRecord(resolved.addresses) as Record<string, Record<string, unknown>>;

    // #then it asserts what it asserts, and shows the addresses behind it
    expect(record["separation"]?.["ownerIsAgent"]).toBe(false);
    expect(record["separation"]?.["agentIsPublisher"]).toBe(false);
    expect(record["separation"]?.["publisherIsOwner"]).toBe(true);
    expect(record["separation"]?.["undeclaredCollisions"]).toEqual([]);
    expect(record["agent"]?.["address"]).toBe(resolved.addresses.agent);
    expect(record["agent"]?.["sessionKey"]).toBe(resolved.addresses.sessionKey);
    expect(record["owner"]?.["address"]).toBe(
      privateKeyToAccount(OWNER_KEY).address.toLowerCase() as Address,
    );
  });

  it("reports a collapse rather than hiding it", async () => {
    // #given a record whose roles collapsed
    const resolved = await roles();
    const collapsed: RoleAddresses = { ...resolved.addresses, agent: resolved.addresses.owner };
    const record = roleRecord(collapsed) as Record<string, Record<string, unknown>>;

    // #then the assertion is contradicted in the same document, so a manifest
    // written by a run that should have been blocked still says so
    expect(record["separation"]?.["ownerIsAgent"]).toBe(true);
    expect(record["separation"]?.["undeclaredCollisions"]).not.toEqual([]);
  });
});

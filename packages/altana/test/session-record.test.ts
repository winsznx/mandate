import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  assertNoKeyMaterial,
  deserializePermissions,
  requestedPermissionsHash,
  serializePermissions,
} from "../src/session-record.js";
import type { RequestedSessionPermissions } from "../src/effective-authority.js";

const VUSDT: Address = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a";
const USDT: Address = "0x55d398326f99059ff775485246999027b3197955";

const PERMISSIONS: RequestedSessionPermissions = {
  calls: [{ to: VUSDT, signature: "repayBorrow(uint256)" }],
  // 25 USDT at 18 decimals. Far beyond Number.MAX_SAFE_INTEGER.
  spend: [{ token: USDT, limit: 25_000_000_000_000_000_000n, period: "day" }],
};

describe("session permission serialization", () => {
  it("round-trips a mainnet-scale spend limit without losing a base unit", () => {
    // #given a 25 USDT cap at 18 decimals, which no JSON number can hold
    // #when serialized and restored
    const restored = deserializePermissions(serializePermissions(PERMISSIONS));

    // #then the exact bigint survives. Coercing this through Number would round
    // it and permanently brick the session, with no error at write time.
    expect(restored.spend?.[0]?.limit).toBe(25_000_000_000_000_000_000n);
  });

  it("stores a spend limit as a decimal string, never as a number", () => {
    const serialized = serializePermissions(PERMISSIONS);
    expect(serialized.spend[0]!.limit).toBe("25000000000000000000");
    expect(typeof serialized.spend[0]!.limit).toBe("string");
  });

  it("survives an actual JSON round-trip, which is how it will be persisted", () => {
    // #given the serialized form written to and read back from storage
    const serialized = serializePermissions(PERMISSIONS);

    // #when it goes through JSON, as a database column or a queue message would
    const restored = deserializePermissions(JSON.parse(JSON.stringify(serialized)));

    // #then nothing changed
    expect(restored.spend?.[0]?.limit).toBe(25_000_000_000_000_000_000n);
    expect(restored.calls?.[0]).toEqual({ to: VUSDT, signature: "repayBorrow(uint256)" });
  });

  it("preserves each of the three call-permission shapes", () => {
    // #given one of each arm of the permission union
    const permissions: RequestedSessionPermissions = {
      calls: [{ to: VUSDT, signature: "repayBorrow(uint256)" }, { to: VUSDT }, { signature: "x()" }],
      spend: [],
    };

    // #when round-tripped
    const restored = deserializePermissions(serializePermissions(permissions));

    // #then each shape comes back as itself, since the three mean different things
    expect(restored.calls).toEqual([
      { to: VUSDT, signature: "repayBorrow(uint256)" },
      { to: VUSDT },
      { signature: "x()" },
    ]);
  });

  it("rejects a corrupted limit at load rather than granting a different cap", () => {
    // #given a record whose limit was damaged in storage
    const damaged = { calls: [], spend: [{ limit: "not-a-number", period: "day" as const }] };

    // #when restored
    // #then it throws instead of silently producing NaN
    expect(() => deserializePermissions(damaged)).toThrow();
  });

  it("rejects a call permission carrying neither target nor signature", () => {
    expect(() => deserializePermissions({ calls: [{}], spend: [] })).toThrow(/target, a signature/);
  });
});

describe("requestedPermissionsHash", () => {
  const record = {
    chainId: 97,
    walletAddress: "0x4444444444444444444444444444444444444444" as Address,
    publicKey: `0x04${"ab".repeat(64)}` as const,
    requestedPermissions: serializePermissions(PERMISSIONS),
    expiry: 1_800_000_000,
  };

  it("is stable across independent serializations of the same request", () => {
    const again = { ...record, requestedPermissions: serializePermissions(PERMISSIONS) };
    expect(requestedPermissionsHash(record)).toBe(requestedPermissionsHash(again));
  });

  it("changes when the spend limit changes by one base unit", () => {
    // #given a cap one base unit higher
    const bumped = {
      ...record,
      requestedPermissions: serializePermissions({
        ...PERMISSIONS,
        spend: [{ token: USDT, limit: 25_000_000_000_000_000_001n, period: "day" }],
      }),
    };

    // #then the commitment differs
    expect(requestedPermissionsHash(record)).not.toBe(requestedPermissionsHash(bumped));
  });

  it("changes when the expiry changes", () => {
    expect(requestedPermissionsHash(record)).not.toBe(
      requestedPermissionsHash({ ...record, expiry: record.expiry + 1 }),
    );
  });

  it("changes when the chain changes, so a commitment cannot be replayed", () => {
    expect(requestedPermissionsHash(record)).not.toBe(
      requestedPermissionsHash({ ...record, chainId: 56 }),
    );
  });
});

describe("assertNoKeyMaterial", () => {
  it("accepts a session record, which structurally cannot hold a key", () => {
    expect(() =>
      assertNoKeyMaterial({
        walletAddress: "0x4444444444444444444444444444444444444444",
        publicKey: "0x04ab",
        requestedPermissions: serializePermissions(PERMISSIONS),
      }),
    ).not.toThrow();
  });

  it("refuses an object carrying a private key", () => {
    // #given a session object that still has its signer attached
    const leaked = { walletAddress: "0x44", signer: { privateKey: "0xdead" } };

    // #when checked before persistence
    // #then it is refused, naming the path
    expect(() => assertNoKeyMaterial(leaked)).toThrow(/signer/);
  });

  it("finds key material nested inside an array", () => {
    const leaked = { sessions: [{ ok: true }, { mnemonic: "abandon abandon" }] };
    expect(() => assertNoKeyMaterial(leaked)).toThrow(/sessions\[1\]\.mnemonic/);
  });

  it("matches regardless of field casing", () => {
    expect(() => assertNoKeyMaterial({ PrivateKey: "0xdead" })).toThrow();
  });
});

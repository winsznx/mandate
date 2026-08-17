import { describe, expect, it } from "vitest";
import {
  CapabilityCache,
  CapabilityCacheFormatError,
  parseEntry,
  serialiseEntry,
  type CapabilityCacheEntry,
} from "../src/cache.js";
import {
  capabilityAgeMs,
  isStale,
  requireForkableBlock,
  type RpcCapabilities,
} from "../src/capabilities.js";

/**
 * A fork measurement is expensive to take and dangerous to keep.
 *
 * Expensive because every probe is an anvil process, dangerous because the
 * window it describes slides with the head: a measurement saying "9,375 blocks
 * back" is a statement about a block range that has moved by the time anyone
 * reads it. Everything below is about `checkedAt` being load-bearing rather
 * than decorative.
 */

const HEAD = 125_639_628n;
const TAKEN_AT = 1_786_984_245_687;
const RPC = "https://bsc-testnet-rpc.publicnode.com";

const CAPABILITIES: RpcCapabilities = {
  latestBlock: HEAD,
  historicalCall: { testedDepth: 2_000_000n, oldestSuccessfulBlock: HEAD - 1_800_781n },
  forkState: { testedDepth: 200_000n, oldestSuccessfulBlock: HEAD - 9_375n },
  checkedAt: TAKEN_AT,
};

const ENTRY: CapabilityCacheEntry = { rpcUrl: RPC, chainId: 97, capabilities: CAPABILITIES };

describe("staleness", () => {
  it("treats a measurement inside the window as usable", async () => {
    // #given a measurement one minute old
    // #then it is fresh
    expect(isStale(CAPABILITIES, TAKEN_AT + 60_000, 15 * 60_000)).toBe(false);
    expect(capabilityAgeMs(CAPABILITIES, TAKEN_AT + 60_000)).toBe(60_000);
  });

  it("expires a measurement once the window it describes has moved", async () => {
    // #given a measurement an hour old
    // #then it is stale. BSC produces a block every 0.45 s, so an hour is eight
    // thousand blocks: nearly the whole fork window measured above.
    expect(isStale(CAPABILITIES, TAKEN_AT + 3_600_000, 15 * 60_000)).toBe(true);
  });

  it("treats a backwards clock as stale rather than as very fresh", async () => {
    // #given a `now` earlier than the measurement, which an NTP correction or a
    // container clock skew produces
    // #then the negative age fails closed. Reading it as freshness would make a
    // stale record permanently valid.
    expect(isStale(CAPABILITIES, TAKEN_AT - 1, 15 * 60_000)).toBe(true);
  });

  it("refuses an expired measurement even for a block it says is forkable", async () => {
    // #given a block well inside the measured window
    const block = HEAD - 2_000n;
    expect(requireForkableBlock(CAPABILITIES, block, { now: TAKEN_AT }).ok).toBe(true);

    // #when the measurement has aged out
    const admission = requireForkableBlock(CAPABILITIES, block, {
      now: TAKEN_AT + 3_600_000,
      maxAgeMs: 15 * 60_000,
    });

    // #then it is refused and marked as worth re-probing, rather than trusted
    // because it once said yes
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("unreachable");
    expect(admission.needsProbe).toBe(true);
    expect(admission.error.kind).toBe("FORK_STATE_UNAVAILABLE");
    expect(admission.error.pausesQueue).toBe(true);
  });
});

describe("the cache", () => {
  it("keys on the endpoint and the chain together", async () => {
    // #given one measurement stored for chain 97
    const cache = new CapabilityCache();
    cache.put(ENTRY);

    // #then the same URL under a different chain is a miss. Two chains behind
    // one hostname is the publicnode pattern, and a copied config that keeps
    // the URL would otherwise read the wrong provider's window.
    expect(cache.fresh(RPC, 97, TAKEN_AT)).toBeDefined();
    expect(cache.fresh(RPC, 56, TAKEN_AT)).toBeUndefined();
  });

  it("withholds a stale entry from the scheduler path", async () => {
    // #given an entry that has aged past the window
    const cache = new CapabilityCache(15 * 60_000);
    cache.put(ENTRY);

    // #then `fresh` declines to hand it over
    expect(cache.fresh(RPC, 97, TAKEN_AT + 3_600_000)).toBeUndefined();
  });

  it("still shows a stale entry to anyone asking how old it is", async () => {
    // #given the same stale entry
    const cache = new CapabilityCache(15 * 60_000);
    cache.put(ENTRY);

    // #when it is looked up rather than requested
    const found = cache.lookup(RPC, 97, TAKEN_AT + 3_600_000);

    // #then the age and the verdict are both visible. An operator deciding
    // whether to spend two minutes re-probing should not have to make that call
    // blind because the cache pretended to hold nothing.
    expect(found?.stale).toBe(true);
    expect(found?.ageMs).toBe(3_600_000);
  });
});

describe("serialisation", () => {
  it("round-trips a measurement without losing a block number", async () => {
    // #given an entry carrying bigints, which JSON cannot represent
    const restored = parseEntry(JSON.parse(JSON.stringify(serialiseEntry(ENTRY))));

    // #then every figure comes back exactly. A dropped `latestBlock` would turn
    // every depth in the record into a comparison against zero.
    expect(restored).toEqual(ENTRY);
  });

  it("preserves the difference between unprobed and probed-and-empty", async () => {
    // #given one capability never probed and one probed with nothing working
    const entry: CapabilityCacheEntry = {
      ...ENTRY,
      capabilities: {
        ...CAPABILITIES,
        historicalCall: { testedDepth: 0n },
        forkState: { testedDepth: 200_000n },
      },
    };

    // #when it is stored and read back
    const restored = parseEntry(JSON.parse(JSON.stringify(serialiseEntry(entry))));

    // #then neither has acquired an oldest block, and the two stay distinct:
    // one is answered by running a probe and the other by finding another RPC
    expect(restored.capabilities.historicalCall.oldestSuccessfulBlock).toBeUndefined();
    expect(restored.capabilities.forkState.testedDepth).toBe(200_000n);
  });

  it("refuses an entry whose age cannot be established", async () => {
    // #given a stored record with no `checkedAt`
    const { checkedAt: _dropped, ...rest } = serialiseEntry(ENTRY);

    // #then it is rejected rather than defaulted. A capability record with no
    // age is one that can never be shown to have expired.
    expect(() => parseEntry(rest)).toThrow(CapabilityCacheFormatError);
  });

  it("refuses an entry missing a measurement rather than reading it as empty", async () => {
    // #given a record whose forkState did not survive whatever wrote it
    const { forkState: _dropped, ...rest } = serialiseEntry(ENTRY);

    // #then it is rejected. Silently reading the gap as "nothing worked" would
    // refuse every scenario on a provider that was fine.
    expect(() => parseEntry(rest)).toThrow(CapabilityCacheFormatError);
  });
});

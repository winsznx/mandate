import { describe, expect, it } from "vitest";
import {
  DepthSearchError,
  retryingProbe,
  searchDepth,
  type DepthProbe,
  type RetryableProbe,
} from "../src/search.js";

/**
 * The bisection, against probes that answer instantly and identically forever.
 *
 * Every assertion here is about arithmetic and bookkeeping, so none of it needs
 * a network. That separation is the point: the live suite measures a third
 * party and cannot be a gate, while this one is deterministic and can.
 */

/** A provider that serves everything down to `limit` blocks back and nothing beyond. */
function providerWithLimit(limit: bigint, calls: bigint[] = []): DepthProbe {
  return async (depth: bigint) => {
    calls.push(depth);
    return depth <= limit;
  };
}

describe("bisecting for a capability boundary", () => {
  it("finds a boundary it was never told about", async () => {
    // #given a provider that serves 2,000 blocks back and no further
    const probe = providerWithLimit(2_000n);

    // #when the search looks over a range two orders of magnitude wider
    const result = await searchDepth(probe, { maxDepth: 200_000n, maxProbes: 32 });

    // #then it lands on the real limit rather than on any assumed number
    expect(result.deepestSuccessfulDepth).toBe(2_000n);
    expect(result.resolutionBlocks).toBe(0n);
    expect(result.boundaryObserved).toBe(true);
  });

  it("spends a probe count that is logarithmic in the range", async () => {
    // #given a range of one million blocks
    const probe = providerWithLimit(105_468n);

    // #when the boundary is resolved exactly
    const result = await searchDepth(probe, { maxDepth: 1_000_000n, maxProbes: 64 });

    // #then it costs about log2 of the range, plus the probe at the head
    expect(result.deepestSuccessfulDepth).toBe(105_468n);
    expect(result.probes).toBeLessThanOrEqual(22);
  });

  it("stops at the probe budget and says how wide the gap it left is", async () => {
    // #given a budget far below what an exact answer would cost
    const probe = providerWithLimit(2_000n);

    // #when the search runs out of probes
    const result = await searchDepth(probe, { maxDepth: 200_000n, maxProbes: 6 });

    // #then it reports a boundary it is sure is deep enough, and the width of
    // the window it never got to ask about. A search that rounded that away
    // would be claiming precision it did not buy.
    expect(result.probes).toBe(6);
    expect(result.resolutionBlocks).toBeGreaterThan(0n);
    const deepest = result.deepestSuccessfulDepth as bigint;
    expect(deepest).toBeLessThanOrEqual(2_000n);
    expect(deepest + result.resolutionBlocks).toBeGreaterThanOrEqual(2_000n);
  });

  it("probes the head first, and stops there when the head fails", async () => {
    // #given an endpoint that answers nothing at all
    const calls: bigint[] = [];
    const probe: DepthProbe = async (depth) => {
      calls.push(depth);
      return false;
    };

    // #when it is searched
    const result = await searchDepth(probe, { maxDepth: 1_000_000n, maxProbes: 20 });

    // #then one probe settles it. Bisecting a broken endpoint would burn the
    // whole budget to rediscover the same answer at every depth.
    expect(calls).toEqual([0n]);
    expect(result.deepestSuccessfulDepth).toBeNull();
    expect(result.boundaryObserved).toBe(true);
  });

  it("reports an unreached boundary when everything in range worked", async () => {
    // #given a genuine archive that serves the whole searched range
    const probe = providerWithLimit(10n ** 12n);

    // #when the search completes without a single failure
    const result = await searchDepth(probe, { maxDepth: 5_000n, maxProbes: 32 });

    // #then the limit is recorded as not reached rather than as 5,000. The
    // provider's real limit is deeper than anyone looked, and saying otherwise
    // would invent the same kind of constant this package exists to delete.
    expect(result.deepestSuccessfulDepth).toBe(5_000n);
    expect(result.boundaryObserved).toBe(false);
  });

  it("never probes deeper than the range it was given", async () => {
    // #given a search bounded at 1,000 blocks
    const calls: bigint[] = [];
    const probe = providerWithLimit(10n ** 9n, calls);

    // #when it runs
    await searchDepth(probe, { maxDepth: 1_000n, maxProbes: 32 });

    // #then nothing outside the stated range was asked about
    expect(Math.max(...calls.map(Number))).toBeLessThanOrEqual(1_000);
  });

  it("rejects a budget that cannot produce a measurement", async () => {
    // #given a nonsensical probe budget
    // #then it is refused up front rather than returning an empty result
    await expect(
      searchDepth(providerWithLimit(1n), { maxDepth: 10n, maxProbes: 0 }),
    ).rejects.toBeInstanceOf(DepthSearchError);
    await expect(
      searchDepth(providerWithLimit(1n), { maxDepth: -1n, maxProbes: 4 }),
    ).rejects.toBeInstanceOf(DepthSearchError);
  });
});

describe("retrying probes that did not find anything out", () => {
  const noSleep = async (): Promise<void> => {};

  it("retries a transport failure rather than believing it", async () => {
    // #given a depth that fails twice on the socket and then answers
    let call = 0;
    const flaky: RetryableProbe = async () => {
      call += 1;
      return call < 3 ? { ok: false, retryable: true } : { ok: true, retryable: false };
    };

    // #when it is wrapped with three attempts
    const probe = retryingProbe(flaky, { attempts: 3, backoffMs: 0, sleep: noSleep });

    // #then the capability is found. One dropped connection near the top of a
    // bisection would otherwise discard the entire deeper half of the range.
    expect(await probe(1_000n)).toBe(true);
    expect(call).toBe(3);
  });

  it("does not retry an answer", async () => {
    // #given a depth the node says is pruned
    let call = 0;
    const pruned: RetryableProbe = async () => {
      call += 1;
      return { ok: false, retryable: false };
    };

    // #when it is wrapped with three attempts
    const probe = retryingProbe(pruned, { attempts: 3, backoffMs: 0, sleep: noSleep });

    // #then it is asked exactly once. Repeating an anvil spawn to hear the same
    // "this state is gone" costs a minute per depth and learns nothing.
    expect(await probe(1_000n)).toBe(false);
    expect(call).toBe(1);
  });

  it("gives up conservatively when every attempt was inconclusive", async () => {
    // #given a depth that never answers
    const silent: RetryableProbe = async () => ({ ok: false, retryable: true });

    // #when the attempts are exhausted
    const probe = retryingProbe(silent, { attempts: 2, backoffMs: 0, sleep: noSleep });

    // #then the depth counts as unavailable, which narrows the recorded window.
    // The opposite default would claim a capability nobody ever observed.
    expect(await probe(1_000n)).toBe(false);
  });

  it("backs off further on each successive failure", async () => {
    // #given a probe that keeps failing on transport
    const waits: number[] = [];
    const silent: RetryableProbe = async () => ({ ok: false, retryable: true });

    // #when three attempts are made
    const probe = retryingProbe(silent, {
      attempts: 3,
      backoffMs: 100,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await probe(1n);

    // #then the pauses grow, so a throttled endpoint is given room rather than
    // being hammered at a fixed interval by the whole bisection
    expect(waits).toEqual([100, 200]);
  });
});

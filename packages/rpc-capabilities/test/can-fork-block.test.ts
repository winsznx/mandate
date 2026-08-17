import { describe, expect, it } from "vitest";
import {
  canCallAtBlock,
  canForkBlock,
  measurementFrom,
  requireForkableBlock,
  UNPROBED_DEPTH,
  type RpcCapabilities,
} from "../src/capabilities.js";

/**
 * The question a scheduler is allowed to ask.
 *
 * "Is this block within N blocks of the head" has no correct answer, because
 * there is no N: the two capabilities measured here differ by two orders of
 * magnitude on the same host, and both move. `canForkBlock` replaces it, and
 * its third answer is what makes it honest — `UNKNOWN` says the measurement
 * does not reach the block, and the caller's options are to probe or to refuse.
 */

const HEAD = 125_639_628n;
const NOW = 1_786_984_245_687;

/** The real testnet reading: fork state 9,375 blocks back, calls very much further. */
function measured(overrides: Partial<RpcCapabilities> = {}): RpcCapabilities {
  return {
    latestBlock: HEAD,
    historicalCall: { testedDepth: 2_000_000n, oldestSuccessfulBlock: HEAD - 1_800_781n },
    forkState: { testedDepth: 200_000n, oldestSuccessfulBlock: HEAD - 9_375n },
    checkedAt: NOW,
    ...overrides,
  };
}

describe("canForkBlock", () => {
  it("answers yes for a block inside the measured window", async () => {
    // #given a fork probe that reached 9,375 blocks back
    const capabilities = measured();

    // #then a block 2,000 back is a measured yes
    expect(canForkBlock(capabilities, HEAD - 2_000n)).toBe(true);
    expect(canForkBlock(capabilities, HEAD)).toBe(true);
  });

  it("answers no for a block past an observed failure", async () => {
    // #given the same measurement, whose bisection did see a failure
    const capabilities = measured();

    // #then a block 20,000 back is a measured no, not a maybe
    expect(canForkBlock(capabilities, HEAD - 20_000n)).toBe(false);
    expect(canForkBlock(capabilities, HEAD - 1_000_000n)).toBe(false);
  });

  it("never lets a historical call vouch for a fork", async () => {
    // #given a block the endpoint answers `eth_call` at
    const capabilities = measured();
    const block = HEAD - 100_000n;
    expect(canCallAtBlock(capabilities, block)).toBe(true);

    // #then forking it is still no. This is the whole finding: the same
    // provider served a read 1.8 million blocks back and a fork genesis 9,375
    // blocks back, and treating the first as evidence for the second queues a
    // trial that dies minutes later inside anvil.
    expect(canForkBlock(capabilities, block)).toBe(false);
  });

  it("says UNKNOWN when the capability was never probed", async () => {
    // #given a record where the fork probe was skipped, which is the default
    const capabilities = measured({ forkState: { testedDepth: UNPROBED_DEPTH } });

    // #then even the head is UNKNOWN. An unprobed capability is not a working
    // one, and borrowing the historical result to fill the gap is the mistake.
    expect(canForkBlock(capabilities, HEAD)).toBe("UNKNOWN");
    expect(canForkBlock(capabilities, HEAD - 1n)).toBe("UNKNOWN");
  });

  it("says UNKNOWN below a range where nothing was seen to fail", async () => {
    // #given a search that succeeded at every depth it tried
    const capabilities = measured({
      forkState: measurementFrom(
        { testedDepth: 200_000n, deepestSuccessfulDepth: 200_000n, boundaryObserved: false },
        HEAD,
      ),
    });

    // #then inside the range is yes, and beyond it is unmeasured rather than a
    // limit of 200,000 that nobody observed
    expect(canForkBlock(capabilities, HEAD - 200_000n)).toBe(true);
    expect(canForkBlock(capabilities, HEAD - 200_001n)).toBe("UNKNOWN");
  });

  it("says UNKNOWN for a block newer than the head it measured", async () => {
    // #given a block mined after the measurement was taken
    const capabilities = measured();

    // #then the answer is UNKNOWN, even though a block near the head is the
    // easiest thing to fork. This function cannot see a clock or a chain, and
    // answering yes about a block nobody observed is the same class of mistake
    // as answering with a constant.
    expect(canForkBlock(capabilities, HEAD + 1n)).toBe("UNKNOWN");
  });

  it("says no when the endpoint served nothing at all", async () => {
    // #given an endpoint that failed even at its own head, which is what
    // bsc-rpc.publicnode.com now does: every archive request is refused
    const capabilities = measured({ forkState: { testedDepth: 200_000n } });

    // #then that is a measurement, and it is a measurement of no
    expect(canForkBlock(capabilities, HEAD - 1n)).toBe(false);
  });

  it("is conservative inside a window the bisection did not resolve", async () => {
    // #given a budget-limited search: succeeded at 3,125, failed somewhere below
    const capabilities = measured({
      forkState: measurementFrom(
        { testedDepth: 200_000n, deepestSuccessfulDepth: 3_125n, boundaryObserved: true },
        HEAD,
      ),
    });

    // #then a block just past the deepest success answers no. Refusing a block
    // that would have forked costs a scenario; accepting one that will not
    // costs a fork that dies in genesis after the trial was queued.
    expect(canForkBlock(capabilities, HEAD - 3_125n)).toBe(true);
    expect(canForkBlock(capabilities, HEAD - 3_126n)).toBe(false);
  });
});

describe("requireForkableBlock", () => {
  it("admits a block the endpoint was measured able to fork", async () => {
    // #given a fresh measurement covering the block
    const admission = requireForkableBlock(measured(), HEAD - 2_000n, { now: NOW });

    // #then the scenario runs, and there is no error record to record
    expect(admission.ok).toBe(true);
  });

  it("refuses with FORK_STATE_UNAVAILABLE and pauses the queue", async () => {
    // #when a scenario asks for a block past the measured window
    const admission = requireForkableBlock(measured(), HEAD - 20_000n, { now: NOW });

    // #then the caller gets the trial runner's own infrastructure error, and it
    // pauses the queue. Every trial behind this one fails identically, and each
    // would burn a scenario to rediscover that.
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("unreachable");
    expect(admission.error.kind).toBe("FORK_STATE_UNAVAILABLE");
    expect(admission.error.pausesQueue).toBe(true);
    expect(admission.error.status).toBe("ERROR");
  });

  it("offers no substitute block anywhere in its result", async () => {
    // #given a refusal
    const admission = requireForkableBlock(measured(), HEAD - 20_000n, { now: NOW });
    if (admission.ok) throw new Error("unreachable");

    // #then the result carries a reason and nothing that could be mistaken for
    // an alternative block to run at. Silently moving a scenario to state the
    // provider still holds changes what was measured while leaving the artifact
    // claiming it measured the original.
    expect(Object.keys(admission)).toEqual(["ok", "needsProbe", "error"]);
    expect(admission.error.detail).toContain("unable to fork block");
  });

  it("separates a measured no from a missing measurement", async () => {
    // #given one block past a measured boundary and one never covered
    const measuredNo = requireForkableBlock(measured(), HEAD - 20_000n, { now: NOW });
    const notMeasured = requireForkableBlock(
      measured({ forkState: { testedDepth: UNPROBED_DEPTH } }),
      HEAD - 20_000n,
      { now: NOW },
    );

    // #then both refuse, and only the second is worth re-probing for. Running
    // the expensive anvil bisection again to reconfirm a known no is how an
    // operator learns to skip the probe entirely.
    expect(measuredNo.ok).toBe(false);
    expect(notMeasured.ok).toBe(false);
    if (measuredNo.ok || notMeasured.ok) throw new Error("unreachable");
    expect(measuredNo.needsProbe).toBe(false);
    expect(notMeasured.needsProbe).toBe(true);
  });
});

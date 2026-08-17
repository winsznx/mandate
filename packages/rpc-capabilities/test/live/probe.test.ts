import { describe, expect, it } from "vitest";
import { canCallAtBlock, canForkBlock, requireForkableBlock } from "../../src/capabilities.js";
import { forkAtBlock, anvilVersion } from "../../src/fork-state.js";
import { BSC_TESTNET, BSC_TESTNET_PROBE_CONTRACT } from "../../src/known-contracts.js";
import { probeRpcCapabilities } from "../../src/probe.js";
import { latestBlockNumber } from "../../src/rpc.js";

/**
 * The probes, against the real endpoint, with no mocks anywhere.
 *
 * Excluded from the default suite by `vitest.config.ts` and run through
 * `pnpm test:live`. That separation is not squeamishness about slow tests:
 * every assertion here is a measurement of a third party, and a measurement
 * makes a terrible gate. The numbers below moved while this package was being
 * written — the same host reported a 105,468-block historical window and then
 * a 1,800,781-block one four minutes later — so anything asserting an exact
 * figure would be red by the afternoon.
 *
 * What these tests do assert is the shape of the finding, which has held on
 * every run: the two capabilities are different, forking is the narrower, and
 * the record that comes back says what it tested.
 */

const RPC = process.env["MANDATE_TESTNET_RPC"] ?? "https://bsc-testnet-rpc.publicnode.com";

async function online(): Promise<boolean> {
  try {
    await latestBlockNumber(RPC, { timeoutMs: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const reachable = await online();

describe.skipIf(!reachable).sequential("probing a real endpoint", () => {
  it("measures a historical-call window without being told one", async () => {
    // #when the cheap capability is bisected
    const report = await probeRpcCapabilities({
      rpcUrl: RPC,
      chainId: BSC_TESTNET,
      historicalBudget: { maxDepth: 2_000_000n, maxProbes: 12, attempts: 3 },
    });

    // #then the endpoint served something, and the record says how far the
    // search looked rather than implying it found a provider constant
    expect(report.capabilities.latestBlock).toBeGreaterThan(0n);
    expect(report.historicalCall.probes).toBeLessThanOrEqual(12);
    expect(report.capabilities.historicalCall.testedDepth).toBeGreaterThan(0n);

    // #and the fork capability is untouched, because it was not asked for
    expect(report.forkState).toBeUndefined();
    expect(canForkBlock(report.capabilities, report.capabilities.latestBlock)).toBe("UNKNOWN");
  });

  it("disproves the ~2,048-block retention figure in the research notes", async () => {
    // #given the head
    const head = await latestBlockNumber(RPC);

    // #when a real `eth_call` is made 100,000 blocks back
    const report = await probeRpcCapabilities({
      rpcUrl: RPC,
      chainId: BSC_TESTNET,
      historicalBudget: { maxDepth: 100_000n, maxProbes: 2, attempts: 3 },
    });

    // #then it succeeds, which the documented figure says it cannot. The number
    // in `internal/research/00-DECISIONS.md` §1.1 describes neither capability
    // and must not be coded against.
    expect(canCallAtBlock(report.capabilities, head - 100_000n)).not.toBe(false);
  });

  it("measures fork state as the strictly narrower capability", async () => {
    // #when both capabilities are bisected against the same endpoint
    const report = await probeRpcCapabilities({
      rpcUrl: RPC,
      chainId: BSC_TESTNET,
      historicalBudget: { maxDepth: 2_000_000n, maxProbes: 12, attempts: 3 },
      forkBudget: { maxDepth: 200_000n, maxProbes: 8, attempts: 2 },
    });

    const { latestBlock, historicalCall, forkState } = report.capabilities;
    const callDepth =
      historicalCall.oldestSuccessfulBlock === undefined
        ? 0n
        : latestBlock - historicalCall.oldestSuccessfulBlock;
    const forkDepth =
      forkState.oldestSuccessfulBlock === undefined
        ? 0n
        : latestBlock - forkState.oldestSuccessfulBlock;

    // #then the fork window is the smaller of the two. This is the finding the
    // whole package rests on: a genesis needs whole tries where a call needs a
    // slot, and no provider publishes either number.
    expect(forkDepth).toBeLessThan(callDepth);
    expect(report.anvilVersion).toContain("anvil");
  });

  it("refuses a block past the measured fork window instead of moving it", async () => {
    // #given a measurement of the fork capability
    const report = await probeRpcCapabilities({
      rpcUrl: RPC,
      chainId: BSC_TESTNET,
      historicalBudget: { maxDepth: 1_000n, maxProbes: 2, attempts: 3 },
      forkBudget: { maxDepth: 200_000n, maxProbes: 8, attempts: 2 },
    });

    // #when a scenario asks for a block far outside it
    const admission = requireForkableBlock(
      report.capabilities,
      report.capabilities.latestBlock - 200_000n,
      { now: Date.now() },
    );

    // #then the answer is a refusal that pauses the queue, with no substitute
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("unreachable");
    expect(admission.error.kind).toBe("FORK_STATE_UNAVAILABLE");
    expect(admission.error.pausesQueue).toBe(true);
  });
});

describe.skipIf(!reachable).sequential("a single fork probe", () => {
  it("comes up at the head and answers a real call through the fork", async () => {
    // #given anvil and a block the endpoint definitely still holds
    expect(anvilVersion()).toContain("anvil");
    const head = await latestBlockNumber(RPC);

    // #when a fork is pinned there and read through
    const outcome = await forkAtBlock(
      { rpcUrl: RPC, chainId: BSC_TESTNET, contract: BSC_TESTNET_PROBE_CONTRACT },
      head - 10n,
    );

    // #then it worked. The call matters: anvil answers `eth_blockNumber` from
    // its own head even when the upstream fork backend is dead, so readiness
    // alone proves only that a process is listening.
    expect(outcome.ok).toBe(true);
  });

  it("reports a genesis it cannot build as a non-retryable answer", async () => {
    // #given a block far outside any free BSC endpoint's retention
    const head = await latestBlockNumber(RPC);

    // #when the fork is attempted there
    const outcome = await forkAtBlock(
      { rpcUrl: RPC, chainId: BSC_TESTNET, contract: BSC_TESTNET_PROBE_CONTRACT },
      head - 5_000_000n,
    );

    // #then it failed, and it failed with a reason rather than a timeout that
    // the bisection would have retried at every depth
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason.length).toBeGreaterThan(0);
  });
});

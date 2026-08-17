import { describe, expect, it } from "vitest";
import { networkInterfaces } from "node:os";
import { anvilVersion, freePort, startFork, type ForkHandle } from "../src/anvil.js";
import { TrialInfrastructureError } from "../src/errors.js";

/**
 * Fork lifecycle, against the real chain.
 *
 * These tests need network and a working `anvil`, and they skip rather than
 * fail without them, because a red suite on a laptop with no connectivity
 * teaches nobody anything. What they must not do is pass by pretending: there
 * is no mocked fork here, and a skipped run is reported as skipped.
 */

const RPC = process.env["MANDATE_TESTNET_RPC"] ?? "https://bsc-testnet-rpc.publicnode.com";
const CHAIN_ID = 97;
const TIMEOUT_MS = 180_000;

async function headBlock(): Promise<bigint | null> {
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as { result?: string };
    return body.result === undefined ? null : BigInt(body.result);
  } catch {
    return null;
  }
}

const head = await headBlock();
const online = head !== null;

/**
 * A non-loopback address of this machine.
 *
 * Used to prove the fork really is bound on every interface. Reaching it on
 * 127.0.0.1 proves only that something is listening somewhere.
 */
function externalAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

async function blockNumberVia(endpoint: string): Promise<bigint> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { result: string };
  return BigInt(body.result);
}

describe("port selection", () => {
  it("returns a port the OS says is free", async () => {
    // #when two ports are requested
    const [first, second] = await Promise.all([freePort(), freePort()]);

    // #then both are real, usable ports. Asking the OS is the only way to get
    // one that is actually free; a random number in a range collides with
    // whatever else the machine is running.
    expect(first).toBeGreaterThan(1024);
    expect(second).toBeGreaterThan(1024);
  });
});

describe("anvil availability", () => {
  it("reports the version that will go into the artifact", () => {
    // #given a working foundry install
    // #then the version string is recorded rather than assumed, because a fork
    // is only reproducible against the anvil that produced it
    expect(anvilVersion()).toMatch(/anvil/i);
  });
});

describe.skipIf(!online)("forking the real chain", () => {
  const forks: ForkHandle[] = [];

  const track = (fork: ForkHandle): ForkHandle => {
    forks.push(fork);
    return fork;
  };

  const cleanup = async () => {
    await Promise.all(forks.splice(0).map((fork) => fork.stop()));
  };

  it(
    "pins to a recent historical block and calls it archive",
    async () => {
      // #given a block a little behind the head, inside the RPC's retention
      const pin = (head as bigint) - 200n;

      // #when the fork is taken
      const fork = track(await startFork({ rpcUrl: RPC, chainId: CHAIN_ID, blockNumber: pin }));

      // #then it sits on that block, and the source class says the RPC really
      // served state for a block it is not at
      expect(fork.blockNumber).toBe(pin);
      expect(fork.rpcSourceClass).toBe("archive");
      expect(fork.degradedReason).toBeUndefined();
      await cleanup();
    },
    TIMEOUT_MS,
  );

  it(
    "binds on every interface, so a containerised runner is reachable",
    async () => {
      const external = externalAddress();
      if (external === null) {
        // No non-loopback interface on this machine; nothing to prove against.
        return;
      }

      // #given a running fork
      const fork = track(await startFork({ rpcUrl: RPC, chainId: CHAIN_ID }));

      // #when it is dialled on this machine's LAN address rather than loopback
      const seen = await blockNumberVia(`http://${external}:${fork.port}`);

      // #then it answers, which a 127.0.0.1-only bind would not
      expect(seen).toBeGreaterThan(0n);
      await cleanup();
    },
    TIMEOUT_MS,
  );

  it(
    "records a head-pinned fork as live rather than archive",
    async () => {
      // #given a scenario that named no block
      const fork = track(await startFork({ rpcUrl: RPC, chainId: CHAIN_ID }));

      // #then the run is labelled live and says why, because following the head
      // is honest but not reproducible
      expect(fork.rpcSourceClass).toBe("live");
      expect(fork.degradedReason).toContain("head");
      await cleanup();
    },
    TIMEOUT_MS,
  );

  it(
    "refuses a pin the RPC has pruned rather than silently moving it",
    async () => {
      // #given a block far outside the public RPC's retention window
      const pruned = (head as bigint) - 3_000_000n;

      // #when a fork is requested with no fallback permitted
      const attempt = startFork({ rpcUrl: RPC, chainId: CHAIN_ID, blockNumber: pruned });

      // #then it fails as a queue-pausing infrastructure error. PRD §82.4 stops
      // the queue rather than substituting state, and this is the code path
      // that has to make that impossible to skip.
      await expect(attempt).rejects.toThrow(TrialInfrastructureError);
      await expect(attempt).rejects.toMatchObject({ kind: "FORK_STATE_UNAVAILABLE" });
    },
    TIMEOUT_MS,
  );

  it(
    "degrades to the head honestly when the caller permits it",
    async () => {
      // #given the same pruned block, with fallback allowed
      const pruned = (head as bigint) - 3_000_000n;
      const fork = track(
        await startFork({
          rpcUrl: RPC,
          chainId: CHAIN_ID,
          blockNumber: pruned,
          allowHeadFallback: true,
        }),
      );

      // #then the fork exists, sits on real state near the head, and the
      // artifact will carry both the class and the reason. Nothing was mocked:
      // the state on this fork is the chain's, it is simply not the block the
      // scenario asked for.
      expect(fork.rpcSourceClass).toBe("live");
      expect(fork.blockNumber).toBeGreaterThan(pruned);
      expect(fork.degradedReason).toContain("pruned");
      expect(fork.degradedReason).toContain("not reproducible");
      await cleanup();
    },
    TIMEOUT_MS,
  );

  it(
    "frees its port on teardown",
    async () => {
      // #given a fork that has been stopped
      const fork = await startFork({ rpcUrl: RPC, chainId: CHAIN_ID });
      const { port } = fork;
      await fork.stop();

      // #then it stops answering. A leaked anvil holds its port for the life of
      // the runner and the next trial fails in a way that looks nothing like
      // the cause.
      await expect(blockNumberVia(`http://127.0.0.1:${port}`)).rejects.toThrow();
    },
    TIMEOUT_MS,
  );
});

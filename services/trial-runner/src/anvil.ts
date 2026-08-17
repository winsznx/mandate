/**
 * Anvil fork lifecycle: spawn, pin, wait, tear down.
 *
 * A trial is only comparable to a rerun if both saw the same chain, which means
 * pinning to a block rather than following the head. That is where BSC gets
 * awkward. There is no reliable free BSC archive RPC — `bsc-testnet.drpc.org`
 * load-balances across archive and pruned backends, and the public dataseeds
 * retain a narrow window — so a pin at an arbitrary historical block fails at
 * genesis with `state at block #N is pruned`. Measured against
 * `bsc-testnet-rpc.publicnode.com`: a pin a couple of thousand blocks back
 * succeeded, twenty thousand back did not, and the boundary moves.
 *
 * The runner therefore attempts the pin it was asked for and, when the RPC
 * cannot serve that state, degrades to the head and says so. It records
 * `rpcSourceClass: "live"` and the reason on the artifact. It never substitutes
 * fabricated state for the state it could not fetch: PRD §82.4 pauses the trial
 * queue rather than mocking, because a trial run against invented balances
 * proves nothing and publishing it as though it did is the failure mode this
 * whole system exists to prevent.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { RpcSourceClass } from "@mandate/domain";
import { TrialInfrastructureError } from "./errors.js";

/** Bound on every interface so a containerised runner is reachable from the host. */
const BIND_HOST = "0.0.0.0";
/** Loopback for the runner's own calls; `0.0.0.0` is not a destination address. */
const DIAL_HOST = "127.0.0.1";

const READY_TIMEOUT_MS = 45_000;
const READY_POLL_MS = 250;

/** Anvil's own words when the upstream RPC has pruned the state a pin needs. */
const PRUNED_STATE_SIGNATURES = [
  "is pruned",
  "historical state is not available",
  "missing trie node",
  "failed to create genesis",
];

/**
 * Failures that say nothing about whether the state exists.
 *
 * The free BSC endpoints drop connections under a sustained read load, and a
 * trial queue is exactly that. Retrying these is not papering over a problem;
 * treating a dropped socket as "this block has been pruned" would be, because
 * it would send an honest archive run down the degradation path and label the
 * artifact `live` when the RPC could have served the pin perfectly well.
 */
const TRANSIENT_SIGNATURES = [
  "connection error",
  "connection reset",
  "sendrequest",
  "close_notify",
  "timed out",
  "timeout",
  "failed to get fork block number",
  "error sending request",
];

const TRANSIENT_RETRIES = 2;
const TRANSIENT_BACKOFF_MS = 2_000;

export interface ForkRequest {
  readonly rpcUrl: string;
  readonly chainId: number;
  /**
   * The block to pin to. Omit to pin to the head, which is honest but not
   * reproducible and is recorded as such.
   */
  readonly blockNumber?: bigint;
  /**
   * Degrade to a head-pinned fork when the pinned block's state is unavailable.
   *
   * Off by default. A caller that needs reproducibility should get an error
   * rather than a quietly different run.
   */
  readonly allowHeadFallback?: boolean;
}

export interface ForkHandle {
  readonly endpoint: string;
  readonly port: number;
  readonly blockNumber: bigint;
  readonly blockHash: `0x${string}`;
  readonly rpcSourceClass: RpcSourceClass;
  /** Present whenever `rpcSourceClass` is `live`. States what stopped the pin. */
  readonly degradedReason?: string;
  readonly anvilVersion: string;
  stop(): Promise<void>;
}

/** Anvil's reported version, for the environment record. */
export function anvilVersion(): string {
  const result = spawnSync("anvil", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new TrialInfrastructureError(
      "FORK_SPAWN_FAILED",
      `anvil is not runnable: ${result.error?.message ?? result.stderr}`,
    );
  }
  const version = result.stdout.split("\n")[0]?.trim();
  if (version === undefined || version.length === 0) {
    throw new TrialInfrastructureError("FORK_SPAWN_FAILED", "anvil reported no version");
  }
  return version;
}

/**
 * Ask the OS for a port it is not using.
 *
 * Binding to port 0 and reading back the assignment is the only way to get one
 * that is actually free; a random number in a range collides with whatever else
 * the CI machine is running, and the collision surfaces as a confusing fork
 * failure rather than an address-in-use.
 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, DIAL_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function rpc<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** A JSON-RPC call against a running fork, surfaced as an infrastructure failure when it dies. */
export async function forkRpc<T>(handle: ForkHandle, method: string, params: unknown[]): Promise<T> {
  try {
    return await rpc<T>(handle.endpoint, method, params);
  } catch (error) {
    throw new TrialInfrastructureError(
      "FORK_DIED",
      `${method} against the fork failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface SpawnedAnvil {
  readonly child: ChildProcess;
  readonly endpoint: string;
  readonly port: number;
  readonly log: () => string;
}

async function spawnAnvil(request: ForkRequest, pin: bigint | undefined): Promise<SpawnedAnvil> {
  const port = await freePort();
  const args = [
    "--fork-url",
    request.rpcUrl,
    "--host",
    BIND_HOST,
    "--port",
    String(port),
    "--chain-id",
    String(request.chainId),
    "--silent",
  ];
  if (pin !== undefined) args.push("--fork-block-number", pin.toString(10));

  const child = spawn("anvil", args, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });

  return { child, endpoint: `http://${DIAL_HOST}:${port}`, port, log: () => log };
}

async function waitForReady(spawned: SpawnedAnvil): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
      throw new TrialInfrastructureError("FORK_SPAWN_FAILED", spawned.log().trim());
    }
    try {
      await rpc<string>(spawned.endpoint, "eth_blockNumber", []);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  }
  throw new TrialInfrastructureError(
    "FORK_SPAWN_FAILED",
    `anvil did not answer within ${READY_TIMEOUT_MS}ms: ${spawned.log().trim()}`,
  );
}

function stopper(child: ChildProcess): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      // A fork that ignores SIGTERM would otherwise hold its port for the rest
      // of the process, and the next trial in the queue would fail to bind.
      const escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => clearTimeout(escalation));
    });
}

/**
 * Classify a fork that never came up.
 *
 * A transport failure surviving every retry is an unavailable RPC, not a broken
 * fork, and it pauses the queue: every trial behind it fails the same way, and
 * each one would burn a scenario to rediscover that.
 */
function spawnFailure(failure: string): TrialInfrastructureError {
  return new TrialInfrastructureError(
    isTransient(failure) ? "RPC_UNAVAILABLE" : "FORK_SPAWN_FAILED",
    failure,
  );
}

function isTransient(log: string): boolean {
  const lowered = log.toLowerCase();
  return TRANSIENT_SIGNATURES.some((signature) => lowered.includes(signature));
}

/**
 * Did the fork fail because the state is gone, or because the socket dropped?
 *
 * Checked in that order deliberately. Anvil reports a pruned pin through a
 * generic `failed to create genesis` wrapper that also appears around transport
 * failures, so a transient signature anywhere in the log wins: mislabelling a
 * dropped connection as pruned state degrades an archive-capable run to `live`
 * and puts a false disclosure on the artifact.
 */
function isPrunedState(log: string): boolean {
  if (isTransient(log)) return false;
  const lowered = log.toLowerCase();
  return PRUNED_STATE_SIGNATURES.some((signature) => lowered.includes(signature));
}

async function describeHead(endpoint: string): Promise<{ number: bigint; hash: `0x${string}` }> {
  const block = await rpc<{ number: string; hash: `0x${string}` }>(endpoint, "eth_getBlockByNumber", [
    "latest",
    false,
  ]);
  return { number: BigInt(block.number), hash: block.hash };
}

/**
 * Start a fork, pinned if the upstream can serve the state and honestly
 * head-pinned if it cannot.
 *
 * The two outcomes are distinguishable from the handle alone, which is what
 * lets the evidence artifact carry the distinction rather than the operator
 * having to remember it.
 */
export async function startFork(request: ForkRequest): Promise<ForkHandle> {
  const version = anvilVersion();

  const attemptOnce = async (
    pin: bigint | undefined,
  ): Promise<{ spawned: SpawnedAnvil } | { failure: string }> => {
    const spawned = await spawnAnvil(request, pin);
    try {
      await waitForReady(spawned);
      return { spawned };
    } catch (error) {
      await stopper(spawned.child)();
      return { failure: error instanceof TrialInfrastructureError ? error.detail : String(error) };
    }
  };

  const attempt = async (
    pin: bigint | undefined,
  ): Promise<{ spawned: SpawnedAnvil } | { failure: string }> => {
    let last: { failure: string } = { failure: "the fork was never attempted" };
    for (let round = 0; round <= TRANSIENT_RETRIES; round += 1) {
      const result = await attemptOnce(pin);
      if ("spawned" in result) return result;
      last = result;
      if (!isTransient(result.failure)) return result;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_BACKOFF_MS * (round + 1)));
    }
    return last;
  };

  const finish = async (
    spawned: SpawnedAnvil,
    sourceClass: RpcSourceClass,
    degradedReason?: string,
  ): Promise<ForkHandle> => {
    const head = await describeHead(spawned.endpoint);
    return {
      endpoint: spawned.endpoint,
      port: spawned.port,
      blockNumber: head.number,
      blockHash: head.hash,
      rpcSourceClass: sourceClass,
      ...(degradedReason === undefined ? {} : { degradedReason }),
      anvilVersion: version,
      stop: stopper(spawned.child),
    };
  };

  if (request.blockNumber === undefined) {
    const headOnly = await attempt(undefined);
    if ("failure" in headOnly) throw spawnFailure(headOnly.failure);
    return finish(
      headOnly.spawned,
      "live",
      "the scenario requested no pinned block, so the fork followed the chain head",
    );
  }

  const pinned = await attempt(request.blockNumber);
  if ("spawned" in pinned) {
    // The upstream served historical state for a block it is not at, which is
    // the only thing "archive" is being claimed to mean here.
    return finish(pinned.spawned, "archive");
  }

  if (!isPrunedState(pinned.failure)) {
    throw spawnFailure(pinned.failure);
  }

  if (request.allowHeadFallback !== true) {
    throw new TrialInfrastructureError(
      "FORK_STATE_UNAVAILABLE",
      `the RPC has pruned the state at block ${request.blockNumber} and no fallback was permitted: ${pinned.failure}`,
    );
  }

  const degraded = await attempt(undefined);
  if ("failure" in degraded) {
    throw new TrialInfrastructureError("FORK_STATE_UNAVAILABLE", degraded.failure);
  }

  return finish(
    degraded.spawned,
    "live",
    `the RPC has pruned the state at block ${request.blockNumber}, so the fork was taken at the chain head instead; this run is not reproducible against the same RPC`,
  );
}

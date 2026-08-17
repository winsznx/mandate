/**
 * The expensive capability: will anvil actually build a fork at this block?
 *
 * There is no RPC method that answers this. Anvil's genesis pulls whole account
 * and storage tries for every account the fork touches, plus the block header
 * and the state root, and it does so over a batch of requests that a
 * load-balanced free endpoint may route to different backends. An endpoint that
 * answers `eth_call` at a block will still fail here, and by a large factor —
 * that is the whole reason this package exists rather than a constant.
 *
 * So the probe is the real thing: spawn anvil against the endpoint pinned at the
 * block, make one genuine `eth_call` through the fork, kill it. There is no
 * cheaper proxy, and the honest way to say that is to pay for it. Each probe
 * costs a process spawn and a genesis sync, which is why the whole capability is
 * opt-in and cached rather than run before every trial.
 *
 * The one real `eth_call` at the end is not ceremony. Anvil will happily come up
 * and answer `eth_blockNumber` from its own in-memory head while the upstream
 * fork backend is dead, so a readiness check alone proves only that a process is
 * listening. Reading a token's supply through the fork is what proves the forked
 * state is there.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { callAtBlock, type HistoricalCallOutcome } from "./historical-call.js";
import { classifyRpcFailure, jsonRpc } from "./rpc.js";

/** Bound on every interface, matching the trial runner, so a containerised probe is reachable. */
const BIND_HOST = "0.0.0.0";
/** Loopback for our own calls; `0.0.0.0` is not a destination address. */
const DIAL_HOST = "127.0.0.1";

const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 250;
const SIGKILL_GRACE_MS = 5_000;

/**
 * Anvil's words when the upstream cannot serve the pin.
 *
 * Kept in step with `services/trial-runner/src/anvil.ts`, which classifies the
 * same log for the same reason. If anvil's phrasing changes, both move.
 */
const PRUNED_STATE_SIGNATURES = [
  "is pruned",
  "historical state is not available",
  "missing trie node",
  "failed to create genesis",
];

const TRANSIENT_SIGNATURES = [
  "connection error",
  "connection reset",
  "sendrequest",
  "close_notify",
  "timed out",
  "timeout",
  "failed to get fork block number",
  "error sending request",
  "too many requests",
  "429",
];

export interface ForkProbeConfig {
  readonly rpcUrl: string;
  readonly chainId: number;
  /** Must predate the deepest block the search will reach. */
  readonly contract: string;
  readonly readyTimeoutMs?: number;
}

export type ForkProbeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: string };

export class AnvilUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnvilUnavailableError";
  }
}

/** Anvil's reported version, recorded so a measurement names the binary that made it. */
export function anvilVersion(): string {
  const result = spawnSync("anvil", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new AnvilUnavailableError(
      `anvil is not runnable: ${result.error?.message ?? result.stderr}`,
    );
  }
  const version = result.stdout.split("\n")[0]?.trim();
  if (version === undefined || version.length === 0) {
    throw new AnvilUnavailableError("anvil reported no version");
  }
  return version;
}

/**
 * Ask the OS for a port it is not using.
 *
 * Binding to port 0 and reading the assignment back is the only way to get one
 * that is genuinely free. A random number in a range collides with whatever
 * else the machine is running, and the collision surfaces as a fork that failed
 * to start, which this package would then record as a pruned block.
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

/**
 * Spawn a fork at `block`, read one value through it, tear it down.
 *
 * Always tears down, including on the paths that throw. A leaked anvil holds
 * its port and its upstream connection for the life of the process, and a
 * bisection leaks one per probe.
 */
export async function forkAtBlock(
  config: ForkProbeConfig,
  block: bigint,
): Promise<ForkProbeOutcome> {
  const port = await freePort();
  const endpoint = `http://${DIAL_HOST}:${port}`;
  const args = [
    "--fork-url",
    config.rpcUrl,
    "--fork-block-number",
    block.toString(10),
    "--host",
    BIND_HOST,
    "--port",
    String(port),
    "--chain-id",
    String(config.chainId),
    "--silent",
  ];

  const child = spawn("anvil", args, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString("utf8");
  });

  try {
    const ready = await waitForReady(child, endpoint, config.readyTimeoutMs ?? READY_TIMEOUT_MS);
    if (!ready) return classifyLog(log, block);

    const call: HistoricalCallOutcome = await callAtBlock(
      { rpcUrl: endpoint, latestBlock: block, contract: config.contract },
      block,
    );
    if (call.ok) return { ok: true };

    // The fork came up but could not serve the state it was supposed to have
    // pulled. Anvil writes the reason into its own log, which is more specific
    // than the JSON-RPC error it hands back, so the log wins where it says
    // anything at all.
    const fromLog = classifyLog(log, block);
    return fromLog.ok
      ? { ok: false, retryable: call.retryable, reason: call.reason }
      : fromLog;
  } finally {
    await stop(child);
  }
}

async function waitForReady(
  child: ChildProcess,
  endpoint: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const outcome = await jsonRpc<string>(endpoint, "eth_blockNumber", [], { timeoutMs: 5_000 });
    if (outcome.kind === "OK") return true;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return false;
}

/**
 * Did the fork fail because the state is gone, or because the socket dropped?
 *
 * Checked in that order deliberately, matching the trial runner. Anvil reports
 * a pruned pin through a generic `failed to create genesis` wrapper that also
 * appears around transport failures, so a transient signature anywhere in the
 * log wins. Calling a dropped connection "pruned" narrows the recorded window
 * on an endpoint that was capable, and every scenario behind it then gets
 * refused for a limit that does not exist.
 */
function classifyLog(log: string, block: bigint): ForkProbeOutcome {
  const lowered = log.toLowerCase();
  if (TRANSIENT_SIGNATURES.some((signature) => lowered.includes(signature))) {
    return { ok: false, retryable: true, reason: summarise(log) };
  }
  if (PRUNED_STATE_SIGNATURES.some((signature) => lowered.includes(signature))) {
    return { ok: false, retryable: false, reason: summarise(log) };
  }
  if (log.trim().length === 0) {
    return {
      ok: false,
      retryable: true,
      reason: `anvil never became ready at block ${block} and said nothing about why`,
    };
  }
  return { ok: false, retryable: classifyRpcFailure(log) === "TRANSPORT", reason: summarise(log) };
}

/** Anvil's genesis failures are verbose and the useful part is at the end. */
function summarise(log: string): string {
  const trimmed = log.trim();
  return trimmed.length <= 400 ? trimmed : `…${trimmed.slice(-400)}`;
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const escalation = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(escalation);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

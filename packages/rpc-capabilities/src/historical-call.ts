/**
 * The cheap capability: can this endpoint answer `eth_call` at an old block?
 *
 * One real call against one real contract, at a real historical block. Not
 * `eth_getBlockByNumber`, which a pruned node answers happily from its header
 * chain while holding none of the state a call needs, and not `eth_getBalance`,
 * which some backends serve from a separate index. A `totalSupply()` on a token
 * has to touch the account trie and one storage slot, which is the smallest
 * thing that genuinely proves historical state is reachable.
 *
 * The result of this probe is not evidence about forking. It is the weaker of
 * the two capabilities by a wide margin — measured at 100,000 blocks against
 * publicnode where the fork probe managed 2,000 — and the two are recorded
 * separately so nothing can quietly substitute one for the other.
 */
import { jsonRpc, TOTAL_SUPPLY_SELECTOR, type RpcCallOptions } from "./rpc.js";

export interface HistoricalCallProbeConfig {
  readonly rpcUrl: string;
  readonly latestBlock: bigint;
  /** Must predate the deepest block the search will reach. */
  readonly contract: string;
  /** Defaults to `totalSupply()`. */
  readonly calldata?: string;
  readonly timeoutMs?: number;
}

export type HistoricalCallOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: string };

export class ProbeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeConfigurationError";
  }
}

/**
 * One call at one block.
 *
 * `retryable` separates "the node said the state is gone" from "the node did
 * not answer". Only the first is a measurement; the second has to be repeated
 * before it is allowed to move the boundary.
 */
export async function callAtBlock(
  config: HistoricalCallProbeConfig,
  block: bigint,
): Promise<HistoricalCallOutcome> {
  if (block < 0n) {
    throw new ProbeConfigurationError(`cannot call at negative block ${block}`);
  }

  const options: RpcCallOptions =
    config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs };

  const outcome = await jsonRpc<string>(
    config.rpcUrl,
    "eth_call",
    [{ to: config.contract, data: config.calldata ?? TOTAL_SUPPLY_SELECTOR }, toBlockTag(block)],
    options,
  );

  if (outcome.kind === "TRANSPORT") {
    return { ok: false, retryable: true, reason: outcome.message };
  }
  if (outcome.kind === "STATE_UNAVAILABLE") {
    return { ok: false, retryable: false, reason: outcome.message };
  }
  if (outcome.value === "0x" || outcome.value.length <= 2) {
    // A healthy node returns empty for a contract that has no code yet. Deep in
    // a bisection that is indistinguishable from pruning, so it is reported as
    // a failure with its own wording rather than silently shortening the window.
    return {
      ok: false,
      retryable: false,
      reason: `the call returned no data at block ${block}; either the state is gone or the probe contract did not exist yet`,
    };
  }
  return { ok: true };
}

/**
 * Fail loudly when the probe contract is wrong, before any bisection runs.
 *
 * A misconfigured address measures as a provider with zero retention, which is
 * a plausible-looking lie. Checking the head first turns it into an error at
 * the top of the run.
 */
export async function assertProbeContractUsable(
  config: HistoricalCallProbeConfig,
): Promise<void> {
  const head = await callAtBlock(config, config.latestBlock);
  if (!head.ok) {
    throw new ProbeConfigurationError(
      `the probe contract ${config.contract} did not answer at the head of ${config.rpcUrl}: ${head.reason}`,
    );
  }
}

function toBlockTag(block: bigint): string {
  return `0x${block.toString(16)}`;
}

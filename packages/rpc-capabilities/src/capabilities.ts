/**
 * What an RPC endpoint was measured to be able to do, and what follows from it.
 *
 * The scheduler's question used to be "is this block within N blocks of the
 * head", with N a constant lifted from a research note. That question has no
 * correct answer, because there is no N. Two capabilities that sound like one
 * are not:
 *
 *   `historicalCall` — can `eth_call` be answered at an old block? Measured
 *   against `bsc-rpc.publicnode.com`, this succeeded 100,000 blocks back and
 *   failed at 1,000,000.
 *
 *   `forkState` — can anvil build a fork genesis from that block, which needs
 *   whole account and storage tries rather than the few slots one call touches?
 *   Measured against the same host family, this failed 20,000 blocks back and
 *   succeeded at 2,000.
 *
 * Fifty times narrower, on the same provider, on the same day. A scheduler that
 * treats a successful historical read as evidence that a fork will pin is
 * wrong by that factor, and the failure surfaces minutes later as an anvil that
 * exits during genesis.
 *
 * So the question this module answers is `canForkBlock(capabilities, block)`,
 * and its third answer is `UNKNOWN`. `UNKNOWN` is not a soft no. It means the
 * measurement does not cover the block, and the caller's options are to probe
 * or to refuse — never to pick a different block and carry on.
 */
import { forkStateUnavailable, type ForkStateUnavailableRecord } from "./errors.js";

/**
 * A capability that was never probed.
 *
 * Distinguished from "probed and found to be zero blocks deep" because the two
 * demand different responses: the first is answered by running a probe, and the
 * second is answered by finding a different RPC.
 */
export const UNPROBED_DEPTH = 0n;

export interface CapabilityMeasurement {
  /**
   * The deepest depth below `latestBlock` this record makes a claim about.
   *
   * `UNPROBED_DEPTH` when the capability was not probed. Otherwise it is
   * constructed so that `latestBlock - oldestSuccessfulBlock < testedDepth`
   * holds exactly when a probe was actually seen to fail — see
   * `measurementFrom`, which is the only supported way to build one. That
   * equivalence is what lets `canForkBlock` tell "measured no" from
   * "never asked", and hand-assembling a record breaks it.
   */
  readonly testedDepth: bigint;
  /**
   * The oldest block at which the capability was observed to work.
   *
   * Absent when no probe in range succeeded, including the probe at the head.
   */
  readonly oldestSuccessfulBlock?: bigint;
}

export interface RpcCapabilities {
  /** The head at measurement time. Every depth in this record is relative to it. */
  readonly latestBlock: bigint;
  /** Historical `eth_call`: a few storage slots at an old block. */
  readonly historicalCall: CapabilityMeasurement;
  /** Anvil fork genesis at an old block. Strictly the harder of the two. */
  readonly forkState: CapabilityMeasurement;
  /** Epoch milliseconds. Retention windows move, so a measurement expires. */
  readonly checkedAt: number;
}

/**
 * Can this provider fork this block?
 *
 * `true` and `false` are measurements. `UNKNOWN` is the absence of one, and it
 * is returned rather than guessed in three situations: the capability was never
 * probed, the block is older than the probe looked, or the block is newer than
 * the head the probe saw.
 *
 * That last one surprises people, because a block near the head is the easiest
 * thing in the world to fork. It is still `UNKNOWN`: the block did not exist
 * when the measurement was taken, this function cannot see a clock or a chain,
 * and answering `true` about a block nobody has observed is the same class of
 * mistake as answering with a constant.
 *
 * Between the deepest observed success and the shallowest observed failure the
 * bisection may have left an unresolved window (`resolutionBlocks` on the search
 * result). Blocks inside it answer `false`. That is deliberately the
 * conservative direction: refusing a block that would in fact have forked costs
 * a scenario, and accepting one that will not costs a fork that dies in genesis
 * after the trial has been queued.
 */
export function canForkBlock(
  capabilities: RpcCapabilities,
  block: bigint,
): boolean | "UNKNOWN" {
  return canServe(capabilities.forkState, capabilities.latestBlock, block);
}

/**
 * The same question for a plain historical read.
 *
 * Kept separate and never used as a stand-in for `canForkBlock`. A provider
 * answering reads 100,000 blocks back tells you nothing about whether it will
 * serve the tries a fork genesis needs.
 */
export function canCallAtBlock(
  capabilities: RpcCapabilities,
  block: bigint,
): boolean | "UNKNOWN" {
  return canServe(capabilities.historicalCall, capabilities.latestBlock, block);
}

function canServe(
  measurement: CapabilityMeasurement,
  latestBlock: bigint,
  block: bigint,
): boolean | "UNKNOWN" {
  if (measurement.testedDepth === UNPROBED_DEPTH) return "UNKNOWN";
  if (block > latestBlock) return "UNKNOWN";

  const oldest = measurement.oldestSuccessfulBlock;
  if (oldest === undefined) {
    // The probe at the head failed, so the endpoint served nothing at all. That
    // is a measurement, and it is a measurement of "no".
    return false;
  }
  if (block >= oldest) return true;

  // Deeper than the deepest success. Either a probe was seen to fail below it,
  // in which case monotonicity — the same assumption the bisection rests on —
  // makes every deeper block a no, or the deepest success was the deepest thing
  // tried and nothing below it was ever asked about.
  const boundaryObserved = latestBlock - oldest < measurement.testedDepth;
  return boundaryObserved ? false : "UNKNOWN";
}

/**
 * Turn a bisection result into a measurement, preserving the invariant above.
 *
 * When the search never saw a failure — every probe succeeded, or the budget
 * ran out first — the record's `testedDepth` is pulled back to the deepest
 * success. Leaving it at the range the search was willing to cover would make
 * the record claim a limit at a depth nobody probed.
 */
export function measurementFrom(
  search: {
    readonly testedDepth: bigint;
    readonly deepestSuccessfulDepth: bigint | null;
    readonly boundaryObserved: boolean;
  },
  latestBlock: bigint,
): CapabilityMeasurement {
  if (search.deepestSuccessfulDepth === null) {
    return { testedDepth: search.testedDepth };
  }
  const testedDepth = search.boundaryObserved ? search.testedDepth : search.deepestSuccessfulDepth;
  return {
    testedDepth,
    oldestSuccessfulBlock: latestBlock - search.deepestSuccessfulDepth,
  };
}

/** Fifteen minutes. Roughly 2,000 BSC blocks at 0.45 s, which is the fork window's own order. */
export const DEFAULT_MAX_AGE_MS = 15 * 60_000;

export function capabilityAgeMs(capabilities: RpcCapabilities, now: number): number {
  return now - capabilities.checkedAt;
}

/**
 * Has the measurement aged out?
 *
 * Retention is a window that slides with the head, so a fork depth measured an
 * hour ago describes a block range that has since moved out from under it. A
 * clock skewed backwards produces a negative age, which is treated as stale
 * rather than as extremely fresh.
 */
export function isStale(
  capabilities: RpcCapabilities,
  now: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): boolean {
  const age = capabilityAgeMs(capabilities, now);
  return age < 0 || age > maxAgeMs;
}

export type ForkAdmission =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** True when the refusal is "not measured" rather than "measured no". */
      readonly needsProbe: boolean;
      readonly error: ForkStateUnavailableRecord;
    };

export interface ForkAdmissionOptions {
  readonly now: number;
  readonly maxAgeMs?: number;
}

/**
 * The gate a scheduler calls before queueing a historical scenario.
 *
 * Every refusal carries the runner's own `FORK_STATE_UNAVAILABLE` record with
 * `pausesQueue: true`, and there is deliberately no third outcome that hands
 * back a substitute block. Moving a scenario to a block the provider happens to
 * still hold changes what the trial measured while leaving the artifact
 * claiming it measured the original — which is the exact failure this project
 * exists to make impossible.
 */
export function requireForkableBlock(
  capabilities: RpcCapabilities,
  block: bigint,
  options: ForkAdmissionOptions,
): ForkAdmission {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (isStale(capabilities, options.now, maxAgeMs)) {
    return {
      ok: false,
      needsProbe: true,
      error: forkStateUnavailable(
        `the fork-state measurement for this endpoint is ${capabilityAgeMs(capabilities, options.now)}ms old, past the ${maxAgeMs}ms limit; retention slides with the head, so block ${block} must be re-probed rather than assumed`,
        options.now,
      ),
    };
  }

  const verdict = canForkBlock(capabilities, block);
  if (verdict === true) return { ok: true };

  if (verdict === "UNKNOWN") {
    return {
      ok: false,
      needsProbe: true,
      error: forkStateUnavailable(
        `no measurement covers block ${block} on this endpoint: the fork probe searched ${capabilities.forkState.testedDepth} blocks below head ${capabilities.latestBlock}`,
        options.now,
      ),
    };
  }

  return {
    ok: false,
    needsProbe: false,
    error: forkStateUnavailable(
      `this endpoint was measured unable to fork block ${block}; the oldest block it forked was ${capabilities.forkState.oldestSuccessfulBlock ?? "none"} below head ${capabilities.latestBlock}`,
      options.now,
    ),
  };
}

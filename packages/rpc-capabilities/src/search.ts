/**
 * Finding the boundary of a capability by measuring it.
 *
 * Every number an implementer would like to hardcode here is wrong. The
 * research notes record "~2,048 blocks back on publicnode" as the testnet
 * retention window; a historical `eth_call` against that same host succeeded
 * 100,000 blocks back and failed at 1,000,000, while an anvil fork of the same
 * host failed at 20,000 and succeeded at 2,000. Those are two different
 * capabilities with two different boundaries, neither of them a documented
 * provider constant, and both of them move as the chain advances and as the
 * provider's backends rotate.
 *
 * So this module takes a probe and finds the boundary, and the only assumption
 * it makes is monotonicity: if a provider can serve state `d` blocks back it can
 * serve state closer to the head, and if it cannot serve `d` it cannot serve
 * anything deeper. That assumption is what makes a bisection meaningful, and it
 * is the assumption a load-balanced endpoint violates — see `noise` below.
 *
 * The probe budget is fixed rather than "run until converged". A fork probe
 * costs a process spawn and a genesis sync, so an unbounded search is a way to
 * spend twenty minutes discovering a number that will have moved by the time it
 * is used. A bounded search leaves a residual window, and the result says how
 * wide that window is instead of pretending the boundary is exact.
 */

/** Answers "did the capability work `depth` blocks below the head?". */
export type DepthProbe = (depth: bigint) => Promise<boolean>;

export interface DepthSearchOptions {
  /**
   * How far back the search is willing to look.
   *
   * Also the honest upper bound on what the result claims: a success at
   * `maxDepth` says nothing about `maxDepth + 1`, and the result records that
   * as an unresolved boundary rather than as a measured limit.
   */
  readonly maxDepth: bigint;
  /** Hard cap on probe calls. The search stops here even mid-bisection. */
  readonly maxProbes: number;
}

export interface DepthSearchResult {
  /** The depth range the search covered. Nothing outside it was measured. */
  readonly testedDepth: bigint;
  /** Deepest depth observed to work, or `null` when nothing in range worked. */
  readonly deepestSuccessfulDepth: bigint | null;
  /** Probe calls actually made. Reported so a slow probe's cost is visible. */
  readonly probes: number;
  /**
   * Width of the window the search never resolved, in blocks.
   *
   * Zero means the boundary is exact: the deepest success and the shallowest
   * failure are adjacent. Non-zero means the budget ran out first and the true
   * boundary is somewhere inside a window this wide, just below
   * `deepestSuccessfulDepth`.
   */
  readonly resolutionBlocks: bigint;
  /**
   * True when a probe failed somewhere in range.
   *
   * When it is false, every probe succeeded and the capability's real limit is
   * deeper than the search looked. `canForkBlock` turns that into `UNKNOWN`
   * rather than into a limit that was never observed.
   */
  readonly boundaryObserved: boolean;
}

export class DepthSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DepthSearchError";
  }
}

/**
 * Bisect for the deepest depth at which `probe` still succeeds.
 *
 * The head is probed first and separately. A provider that cannot answer for
 * the block it is sitting on is broken rather than pruned, and bisecting
 * against a broken provider produces a confident-looking zero. Returning
 * immediately keeps that case distinguishable: one probe, no success, boundary
 * observed at depth zero.
 */
export async function searchDepth(
  probe: DepthProbe,
  options: DepthSearchOptions,
): Promise<DepthSearchResult> {
  if (options.maxDepth < 0n) {
    throw new DepthSearchError(`maxDepth must not be negative, received ${options.maxDepth}`);
  }
  if (!Number.isInteger(options.maxProbes) || options.maxProbes < 1) {
    throw new DepthSearchError(`maxProbes must be a positive integer, received ${options.maxProbes}`);
  }

  let probes = 0;

  probes += 1;
  if (!(await probe(0n))) {
    return {
      testedDepth: options.maxDepth,
      deepestSuccessfulDepth: null,
      probes,
      resolutionBlocks: 0n,
      boundaryObserved: true,
    };
  }

  let deepestSuccess = 0n;
  let shallowestFailure: bigint | null = null;
  let low = 1n;
  let high = options.maxDepth;

  while (low <= high && probes < options.maxProbes) {
    const mid = low + (high - low) / 2n;
    probes += 1;
    if (await probe(mid)) {
      deepestSuccess = mid;
      low = mid + 1n;
    } else {
      shallowestFailure = mid;
      high = mid - 1n;
    }
  }

  // What is left between the two bounds was never asked about. Reporting it as
  // a width rather than rounding it away is the difference between "the limit
  // is 2,000" and "the limit is between 2,000 and 2,244, and here is which".
  const unresolved = high - low + 1n;

  return {
    testedDepth: options.maxDepth,
    deepestSuccessfulDepth: deepestSuccess,
    probes,
    resolutionBlocks: unresolved > 0n ? unresolved : 0n,
    boundaryObserved: shallowestFailure !== null,
  };
}

/**
 * A probe that can say "I did not find out", as distinct from "no".
 *
 * The free BSC endpoints throttle, drop sockets and load-balance across archive
 * and pruned backends. Every one of those produces a failure that says nothing
 * about whether the state exists, and believing it breaks the monotonicity the
 * bisection rests on: one unlucky answer near the top of the search discards
 * the whole deeper half and reports a window an order of magnitude too narrow.
 */
export interface RetryableProbeResult {
  readonly ok: boolean;
  /** True when the failure was transport or throttling rather than an answer. */
  readonly retryable: boolean;
}

export type RetryableProbe = (depth: bigint) => Promise<RetryableProbeResult>;

export interface RetryOptions {
  /** Total tries, not extra tries. One means no retrying. */
  readonly attempts: number;
  /** Multiplied by the attempt number, so the pause grows with each failure. */
  readonly backoffMs?: number;
  /** Injectable so a test does not have to sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF_MS = 1_500;

/**
 * Adapt a retryable probe into the plain yes/no the bisection consumes.
 *
 * A success is never retried: a capability that worked once is available. A
 * non-retryable failure is never retried either, because it is an answer, and
 * repeating an anvil spawn three times to hear the same "this state is pruned"
 * costs a minute per depth for nothing.
 */
export function retryingProbe(probe: RetryableProbe, options: RetryOptions): DepthProbe {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new DepthSearchError(
      `attempts must be a positive integer, received ${options.attempts}`,
    );
  }
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (depth: bigint): Promise<boolean> => {
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      const result = await probe(depth);
      if (result.ok) return true;
      if (!result.retryable) return false;
      if (attempt < options.attempts) await sleep(backoffMs * attempt);
    }
    // Every attempt was inconclusive. Reported as a failure, which is the
    // conservative direction: it narrows the recorded window rather than
    // claiming a capability nobody observed.
    return false;
  };
}

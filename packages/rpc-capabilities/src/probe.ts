/**
 * Running the two probes and turning them into one record.
 *
 * The fork probe is opt-in and the historical probe is not, because they differ
 * in cost by three orders of magnitude: a bisection of historical calls is a
 * dozen HTTP requests, and a bisection of fork pins is a dozen anvil processes
 * each syncing a genesis from a free endpoint. Making the expensive one
 * implicit would put a two-minute stall inside whatever first asked a cheap
 * question.
 *
 * Both budgets are deliberately small. The point of the measurement is not to
 * find the exact block where a provider's retention ends — that number is stale
 * the moment it is written, because the window slides with the head — but to
 * find out whether the block a scenario actually needs is inside it, and to say
 * how confident the answer is.
 */
import {
  measurementFrom,
  type CapabilityMeasurement,
  type RpcCapabilities,
} from "./capabilities.js";
import { anvilVersion, forkAtBlock } from "./fork-state.js";
import {
  assertProbeContractUsable,
  callAtBlock,
  type HistoricalCallProbeConfig,
} from "./historical-call.js";
import { defaultProbeContract } from "./known-contracts.js";
import { latestBlockNumber } from "./rpc.js";
import {
  retryingProbe,
  searchDepth,
  type DepthSearchResult,
  type RetryableProbe,
  type RetryableProbeResult,
} from "./search.js";

export interface SearchBudget {
  readonly maxDepth: bigint;
  readonly maxProbes: number;
  /** How many times a retryable failure is repeated before it is believed. */
  readonly attempts: number;
}

/**
 * Two million blocks is roughly ten days of BSC at 0.45 s.
 *
 * Chosen as a ceiling that is comfortably past anything a trial scenario would
 * ask for, so that a provider which actually serves deep history reports
 * `UNKNOWN` beyond the ceiling rather than a fabricated limit.
 */
export const DEFAULT_HISTORICAL_BUDGET: SearchBudget = {
  maxDepth: 2_000_000n,
  maxProbes: 12,
  attempts: 3,
};

/**
 * Far shallower, because every probe here is an anvil process.
 *
 * Six probes over 200,000 blocks resolves the boundary to about 3,000 blocks,
 * which is the same order as the window itself on the free endpoints. Spending
 * twenty probes to narrow it further measures a number that moves faster than
 * the measurement completes.
 */
export const DEFAULT_FORK_BUDGET: SearchBudget = {
  maxDepth: 200_000n,
  maxProbes: 6,
  attempts: 2,
};

export interface ProbeOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  /** Overrides the chain's default. Must predate the deepest block searched. */
  readonly contract?: string;
  readonly historicalBudget?: SearchBudget;
  /**
   * Present means "also probe fork state", which spawns anvil once per probe.
   *
   * Absent leaves `forkState` unprobed, and `canForkBlock` then answers
   * `UNKNOWN` for every block rather than borrowing the historical result.
   */
  readonly forkBudget?: SearchBudget;
  readonly timeoutMs?: number;
  /** Injectable so a test can pin `checkedAt` without touching the system clock. */
  readonly now?: () => number;
}

export interface CapabilityProbeReport {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly capabilities: RpcCapabilities;
  readonly historicalCall: DepthSearchResult;
  /** Absent when no fork budget was given, which is the default. */
  readonly forkState?: DepthSearchResult;
  /** Present whenever the fork probe ran. Names the binary that produced the measurement. */
  readonly anvilVersion?: string;
  readonly elapsedMs: number;
}

/**
 * Measure what one endpoint can do.
 *
 * Reads the head once and holds it for the whole run. Re-reading it per probe
 * would move every depth's meaning mid-bisection, which is how a search on a
 * chain producing two blocks a second converges on a boundary that was never
 * true at any single moment.
 */
export async function probeRpcCapabilities(
  options: ProbeOptions,
): Promise<CapabilityProbeReport> {
  const clock = options.now ?? Date.now;
  const startedAt = clock();
  const contract = options.contract ?? defaultProbeContract(options.chainId);
  const latestBlock = await latestBlockNumber(
    options.rpcUrl,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );

  const callConfig: HistoricalCallProbeConfig = {
    rpcUrl: options.rpcUrl,
    latestBlock,
    contract,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  await assertProbeContractUsable(callConfig);

  const historicalBudget = options.historicalBudget ?? DEFAULT_HISTORICAL_BUDGET;
  const historicalSearch = await searchDepth(
    retryingProbe(historicalCallProbe(callConfig, latestBlock), {
      attempts: historicalBudget.attempts,
    }),
    { maxDepth: historicalBudget.maxDepth, maxProbes: historicalBudget.maxProbes },
  );

  let forkSearch: DepthSearchResult | undefined;
  let anvil: string | undefined;
  let forkMeasurement: CapabilityMeasurement = { testedDepth: 0n };

  if (options.forkBudget !== undefined) {
    anvil = anvilVersion();
    forkSearch = await searchDepth(
      retryingProbe(forkStateProbe(options.rpcUrl, options.chainId, contract, latestBlock), {
        attempts: options.forkBudget.attempts,
      }),
      { maxDepth: options.forkBudget.maxDepth, maxProbes: options.forkBudget.maxProbes },
    );
    forkMeasurement = measurementFrom(forkSearch, latestBlock);
  }

  return {
    rpcUrl: options.rpcUrl,
    chainId: options.chainId,
    capabilities: {
      latestBlock,
      historicalCall: measurementFrom(historicalSearch, latestBlock),
      forkState: forkMeasurement,
      checkedAt: clock(),
    },
    historicalCall: historicalSearch,
    ...(forkSearch === undefined ? {} : { forkState: forkSearch }),
    ...(anvil === undefined ? {} : { anvilVersion: anvil }),
    elapsedMs: clock() - startedAt,
  };
}

/**
 * Just the cheap half.
 *
 * Exposed on its own so a caller that only needs historical reads never pays
 * for anvil, and so nothing can reach the fork measurement by accident.
 */
export async function probeHistoricalCall(
  options: Omit<ProbeOptions, "forkBudget">,
): Promise<CapabilityProbeReport> {
  return probeRpcCapabilities(options);
}

/** A depth past genesis is a settled no, not something to retry. */
const BEFORE_GENESIS: RetryableProbeResult = { ok: false, retryable: false };

function historicalCallProbe(
  config: HistoricalCallProbeConfig,
  latestBlock: bigint,
): RetryableProbe {
  return async (depth: bigint): Promise<RetryableProbeResult> => {
    if (depth > latestBlock) return BEFORE_GENESIS;
    const outcome = await callAtBlock(config, latestBlock - depth);
    return outcome.ok ? { ok: true, retryable: false } : outcome;
  };
}

function forkStateProbe(
  rpcUrl: string,
  chainId: number,
  contract: string,
  latestBlock: bigint,
): RetryableProbe {
  return async (depth: bigint): Promise<RetryableProbeResult> => {
    if (depth > latestBlock) return BEFORE_GENESIS;
    const outcome = await forkAtBlock({ rpcUrl, chainId, contract }, latestBlock - depth);
    return outcome.ok ? { ok: true, retryable: false } : outcome;
  };
}

/**
 * Holding a measurement, and knowing when to stop trusting it.
 *
 * A fork probe costs minutes, so the result has to be reusable. A retention
 * window slides with the head, so the result has to expire. The cache exists to
 * hold both of those at once: it hands back a measurement and it hands back its
 * age, and every read goes through a freshness check rather than through a
 * hopeful `?? cached`.
 *
 * `checkedAt` is the only thing that makes the record safe to reuse, which is
 * why nothing here can construct an entry without one and why the serialised
 * form keeps it in plain milliseconds rather than a formatted date. Bigints do
 * not survive `JSON.stringify`, so blocks are stored as decimal strings and
 * parsed back; a silently dropped `latestBlock` would turn every depth in the
 * record into a comparison against zero.
 */
import { isStale, DEFAULT_MAX_AGE_MS, type CapabilityMeasurement, type RpcCapabilities } from "./capabilities.js";

export interface CapabilityCacheEntry {
  /** The endpoint the measurement describes. Records are not interchangeable between hosts. */
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly capabilities: RpcCapabilities;
}

export interface CacheLookup {
  readonly entry: CapabilityCacheEntry;
  readonly ageMs: number;
  readonly stale: boolean;
}

/**
 * Keyed on endpoint and chain together.
 *
 * Two chains behind one URL is not hypothetical: the same publicnode hostname
 * pattern serves 56 and 97, and a copied config that keeps the URL while
 * changing the chain would otherwise read the wrong provider's window.
 */
function keyFor(rpcUrl: string, chainId: number): string {
  return `${chainId}|${rpcUrl}`;
}

export class CapabilityCache {
  readonly #entries = new Map<string, CapabilityCacheEntry>();
  readonly #maxAgeMs: number;

  constructor(maxAgeMs: number = DEFAULT_MAX_AGE_MS) {
    this.#maxAgeMs = maxAgeMs;
  }

  get maxAgeMs(): number {
    return this.#maxAgeMs;
  }

  put(entry: CapabilityCacheEntry): void {
    this.#entries.set(keyFor(entry.rpcUrl, entry.chainId), entry);
  }

  /**
   * Look up a measurement and say how old it is.
   *
   * Never filters stale entries out. A caller deciding whether to spend two
   * minutes re-probing wants to see what it has and how old it is, and a cache
   * that answers `undefined` for a record it is holding forces that decision to
   * be made blind.
   */
  lookup(rpcUrl: string, chainId: number, now: number): CacheLookup | undefined {
    const entry = this.#entries.get(keyFor(rpcUrl, chainId));
    if (entry === undefined) return undefined;
    return {
      entry,
      ageMs: now - entry.capabilities.checkedAt,
      stale: isStale(entry.capabilities, now, this.#maxAgeMs),
    };
  }

  /** Only entries still inside the window. The path a scheduler takes. */
  fresh(rpcUrl: string, chainId: number, now: number): CapabilityCacheEntry | undefined {
    const found = this.lookup(rpcUrl, chainId, now);
    return found === undefined || found.stale ? undefined : found.entry;
  }

  clear(): void {
    this.#entries.clear();
  }

  entries(): readonly CapabilityCacheEntry[] {
    return [...this.#entries.values()];
  }
}

interface SerialisedMeasurement {
  readonly testedDepth: string;
  readonly oldestSuccessfulBlock?: string;
}

export interface SerialisedCapabilityEntry {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly latestBlock: string;
  readonly historicalCall: SerialisedMeasurement;
  readonly forkState: SerialisedMeasurement;
  readonly checkedAt: number;
}

export class CapabilityCacheFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityCacheFormatError";
  }
}

export function serialiseEntry(entry: CapabilityCacheEntry): SerialisedCapabilityEntry {
  return {
    rpcUrl: entry.rpcUrl,
    chainId: entry.chainId,
    latestBlock: entry.capabilities.latestBlock.toString(10),
    historicalCall: serialiseMeasurement(entry.capabilities.historicalCall),
    forkState: serialiseMeasurement(entry.capabilities.forkState),
    checkedAt: entry.capabilities.checkedAt,
  };
}

/**
 * Parse a stored entry, rejecting anything it cannot fully reconstruct.
 *
 * A partially parsed capability record is worse than none: a missing
 * `checkedAt` defaults to the epoch and reads as ancient, which is harmless,
 * while a missing `oldestSuccessfulBlock` reads as "nothing worked" and quietly
 * refuses every scenario. Both are avoided by refusing the input.
 */
export function parseEntry(raw: unknown): CapabilityCacheEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new CapabilityCacheFormatError("a cache entry must be an object");
  }
  const record = raw as Partial<SerialisedCapabilityEntry>;
  if (typeof record.rpcUrl !== "string" || record.rpcUrl.length === 0) {
    throw new CapabilityCacheFormatError("a cache entry must name its rpcUrl");
  }
  if (typeof record.chainId !== "number" || !Number.isInteger(record.chainId)) {
    throw new CapabilityCacheFormatError(`${record.rpcUrl}: chainId must be an integer`);
  }
  if (typeof record.checkedAt !== "number" || !Number.isFinite(record.checkedAt)) {
    throw new CapabilityCacheFormatError(
      `${record.rpcUrl}: checkedAt is missing, so the entry's age is unknowable`,
    );
  }
  if (typeof record.latestBlock !== "string") {
    throw new CapabilityCacheFormatError(`${record.rpcUrl}: latestBlock is missing`);
  }

  return {
    rpcUrl: record.rpcUrl,
    chainId: record.chainId,
    capabilities: {
      latestBlock: BigInt(record.latestBlock),
      historicalCall: parseMeasurement(record.rpcUrl, "historicalCall", record.historicalCall),
      forkState: parseMeasurement(record.rpcUrl, "forkState", record.forkState),
      checkedAt: record.checkedAt,
    },
  };
}

function serialiseMeasurement(measurement: CapabilityMeasurement): SerialisedMeasurement {
  return {
    testedDepth: measurement.testedDepth.toString(10),
    ...(measurement.oldestSuccessfulBlock === undefined
      ? {}
      : { oldestSuccessfulBlock: measurement.oldestSuccessfulBlock.toString(10) }),
  };
}

function parseMeasurement(
  rpcUrl: string,
  field: string,
  raw: SerialisedMeasurement | undefined,
): CapabilityMeasurement {
  if (raw === undefined || typeof raw.testedDepth !== "string") {
    throw new CapabilityCacheFormatError(`${rpcUrl}: ${field}.testedDepth is missing`);
  }
  return {
    testedDepth: BigInt(raw.testedDepth),
    ...(raw.oldestSuccessfulBlock === undefined
      ? {}
      : { oldestSuccessfulBlock: BigInt(raw.oldestSuccessfulBlock) }),
  };
}

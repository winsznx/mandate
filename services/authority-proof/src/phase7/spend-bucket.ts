/**
 * The UTC bucket guard.
 *
 * Altana's day-period spend limit is a calendar bucket, not a rolling window.
 * `spent` hard-resets the moment `startOfSpendPeriod` returns a larger value,
 * which makes 00:00 UTC the one instant that can silently destroy this proof:
 * repay 20 at 23:58, attempt 6 at 00:01, and the cap-breach step SUCCEEDS. The
 * run would then report a passing sequence in which the single most important
 * step proved nothing at all, and nothing in the transaction trace would say so.
 *
 * So the bucket is computed from the chain rather than from `Date`, checked
 * against UTC-midnight truncation, and the run refuses to start unless the whole
 * sequence fits inside the bucket that is currently open.
 *
 * The read targets the account IMPLEMENTATION rather than a wallet. The function
 * is `pure`, so it touches no storage, and calling it on the implementation is
 * what lets a run with no wallet and no key still verify the semantics the proof
 * depends on.
 */
import { startOfSpendPeriod } from "@mandate/altana";
import type { Address, PublicClient } from "viem";

export const DAY_SECONDS = 86_400n;

/** `SpendPeriod.Day` in the on-chain enum. */
export const DAY_PERIOD_ENUM = 2;

/**
 * How long the sequence needs, wall clock, worst case.
 *
 * Trial fork and agent invocation up to 300 s, then eleven relayed or direct
 * writes. `grantSession` alone sleeps 12-30 s after confirmation on BSC, and
 * every relay round trip is tens of seconds. Measured generously on purpose: a
 * budget that is too small is indistinguishable from no guard at all.
 */
export const SEQUENCE_BUDGET_SECONDS = 1_200;

/** The margin `00-DECISIONS.md` §3.5 point 5 requires on top of the sequence itself. */
export const BUCKET_SAFETY_MARGIN_SECONDS = 600;

export const MINIMUM_BUCKET_REMAINDER_SECONDS =
  SEQUENCE_BUDGET_SECONDS + BUCKET_SAFETY_MARGIN_SECONDS;

/**
 * The value `00-DECISIONS.md` §1.3 recorded from the deployed implementation.
 *
 * Pinned as a regression vector so the semantic check compares the contract
 * against a number read on a known date, rather than only against MANDATE's own
 * reimplementation of the same rule.
 */
export const PINNED_DAY_VECTOR = { input: 1_786_500_000n, expected: 1_786_492_800n } as const;

export function utcDayStart(timestamp: bigint): bigint {
  return (timestamp / DAY_SECONDS) * DAY_SECONDS;
}

export interface SpendBucket {
  /** Unix seconds the run treated as "now". */
  now: bigint;
  /** Start of the open bucket, as the deployed contract computes it. */
  bucketStart: bigint;
  /** First second of the next bucket. Spend resets here. */
  bucketEnd: bigint;
  remainingSeconds: number;
  /** True when the contract agrees with UTC-midnight truncation on both probes. */
  semanticsMatchUtcMidnight: boolean;
  /** What the contract returned for the pinned vector from `00-DECISIONS.md` §1.3. */
  pinnedVectorResult: bigint;
  /** True when enough of the bucket remains for the whole sequence. */
  sufficientRemainder: boolean;
}

/**
 * Read the open spend bucket and decide whether the sequence may start in it.
 *
 * Both probes matter. The pinned vector catches a contract whose calendar
 * arithmetic changed; the live probe catches a run that is simply too late in
 * the day. A guard with only the second would pass happily against a contract
 * that had stopped bucketing by UTC day at all.
 */
export async function readSpendBucket(
  client: PublicClient,
  params: { accountImplementation: Address; now: bigint },
): Promise<SpendBucket> {
  const [bucketStart, pinnedVectorResult] = await Promise.all([
    startOfSpendPeriod(client, {
      wallet: params.accountImplementation,
      timestamp: params.now,
      periodEnum: DAY_PERIOD_ENUM,
    }),
    startOfSpendPeriod(client, {
      wallet: params.accountImplementation,
      timestamp: PINNED_DAY_VECTOR.input,
      periodEnum: DAY_PERIOD_ENUM,
    }),
  ]);

  const bucketEnd = bucketStart + DAY_SECONDS;
  const remainingSeconds = Number(bucketEnd - params.now);

  return {
    now: params.now,
    bucketStart,
    bucketEnd,
    remainingSeconds,
    semanticsMatchUtcMidnight:
      bucketStart === utcDayStart(params.now) && pinnedVectorResult === PINNED_DAY_VECTOR.expected,
    pinnedVectorResult,
    sufficientRemainder: remainingSeconds >= MINIMUM_BUCKET_REMAINDER_SECONDS,
  };
}

export function describeBucket(bucket: SpendBucket): string {
  const opened = new Date(Number(bucket.bucketStart) * 1000).toISOString();
  const closes = new Date(Number(bucket.bucketEnd) * 1000).toISOString();
  return `bucket ${opened} -> ${closes}, ${bucket.remainingSeconds}s remaining`;
}

/**
 * Has the bucket moved under the run?
 *
 * Checked again immediately before the cap-breach attempt. If it has moved, the
 * account's `spent` counter has reset and the attempt would succeed for a reason
 * that has nothing to do with authority, so the step is abandoned rather than
 * recorded.
 */
export function bucketHeld(observedStart: bigint, expectedStart: bigint): boolean {
  return observedStart === expectedStart;
}

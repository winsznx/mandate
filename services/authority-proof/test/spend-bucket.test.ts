import { describe, expect, it } from "vitest";
import {
  BUCKET_SAFETY_MARGIN_SECONDS,
  DAY_SECONDS,
  MINIMUM_BUCKET_REMAINDER_SECONDS,
  PINNED_DAY_VECTOR,
  SEQUENCE_BUDGET_SECONDS,
  bucketHeld,
  describeBucket,
  utcDayStart,
  type SpendBucket,
} from "../src/phase7/spend-bucket.js";

function bucket(overrides: Partial<SpendBucket> = {}): SpendBucket {
  const now = 1_786_500_000n;
  const bucketStart = utcDayStart(now);
  return {
    now,
    bucketStart,
    bucketEnd: bucketStart + DAY_SECONDS,
    remainingSeconds: Number(bucketStart + DAY_SECONDS - now),
    semanticsMatchUtcMidnight: true,
    pinnedVectorResult: PINNED_DAY_VECTOR.expected,
    sufficientRemainder: true,
    ...overrides,
  };
}

describe("UTC day truncation", () => {
  it("reproduces the value read from the deployed implementation", () => {
    // #given the timestamp `00-DECISIONS.md` §1.3 probed the account with
    // #then MANDATE's own arithmetic agrees with what the contract returned,
    // which is what makes the on-chain check a comparison rather than a
    // restatement of the same code
    expect(utcDayStart(PINNED_DAY_VECTOR.input)).toBe(PINNED_DAY_VECTOR.expected);
  });

  it("puts the last second of a day in that day and the next in the following one", () => {
    // #given the two timestamps either side of a midnight boundary
    const midnight = 1_786_492_800n;

    // #then the boundary is exclusive at the top, which is exactly the moment
    // the account resets `spent`
    expect(utcDayStart(midnight + DAY_SECONDS - 1n)).toBe(midnight);
    expect(utcDayStart(midnight + DAY_SECONDS)).toBe(midnight + DAY_SECONDS);
  });
});

describe("the rollover guard", () => {
  it("requires the sequence budget plus the documented safety margin", () => {
    // #then the threshold is derived from what the run actually takes rather
    // than picked, so changing the sequence changes the guard
    expect(MINIMUM_BUCKET_REMAINDER_SECONDS).toBe(
      SEQUENCE_BUDGET_SECONDS + BUCKET_SAFETY_MARGIN_SECONDS,
    );
    expect(MINIMUM_BUCKET_REMAINDER_SECONDS).toBe(1_800);
  });

  it("states the remaining seconds so the operator knows how long to wait", () => {
    // #given a bucket with 26121 seconds left
    const described = describeBucket(bucket({ remainingSeconds: 26_121 }));

    // #then the number is in the line, not implied by a timestamp
    expect(described).toContain("26121s remaining");
  });

  it("treats a bucket that moved mid-run as a different bucket", () => {
    // #given the bucket the run started in
    const started = utcDayStart(1_786_492_800n);

    // #then a later bucket does not hold, because `spent` has reset and a
    // cap-breach attempt in it would succeed while proving nothing
    expect(bucketHeld(started, started)).toBe(true);
    expect(bucketHeld(started + DAY_SECONDS, started)).toBe(false);
  });
});

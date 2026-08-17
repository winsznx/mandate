/**
 * Wire-level primitives shared by every canonical MANDATE document.
 *
 * The canonical encoding admits only safe integers, so every value that can
 * exceed 2^53 (token amounts, agent ids, block numbers) travels as a decimal
 * string. These schemas are the single place that rule is enforced, and the
 * `*ToBigInt` helpers are the only sanctioned way back to `bigint`.
 */
import { z } from "zod";
import { getAddress, isAddress } from "viem";
import type { Address, Hex } from "viem";

export type { Address, Hex };

/** Lowercase 0x-prefixed hex of any length. Addresses are additionally checksum-validated. */
export const HexSchema = z
  .string()
  .regex(/^0x([0-9a-f][0-9a-f])*$/, "must be lowercase 0x-prefixed hex with an even digit count")
  .transform((value) => value as Hex);

export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "must be lowercase 0x-prefixed 32-byte hex")
  .transform((value) => value as Hex);

/**
 * Addresses are canonicalised to lowercase.
 *
 * Checksum casing carries no protocol meaning but would change the hash of an
 * otherwise identical document, so it is normalised away rather than preserved.
 */
export const AddressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), "must be a 20-byte hex address")
  .transform((value) => getAddress(value).toLowerCase() as Address);

/** Non-negative integer that fits in uint256, carried as a decimal string with no leading zeros. */
export const Uint256Schema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "must be a decimal integer string without leading zeros")
  .refine((value) => BigInt(value) <= (1n << 256n) - 1n, "must fit in uint256");

export type Uint256String = z.infer<typeof Uint256Schema>;

/** Seconds since the Unix epoch. Safe-integer range, so it encodes as a JSON number. */
export const UnixSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(4_102_444_800, "must be before the year 2100");

export const ChainIdSchema = z.number().int().positive();

export const BlockNumberSchema = Uint256Schema;

/** A monotonically ordered semantic version, e.g. `1`, `1.2`, `1.2.3`. */
export const VersionSchema = z
  .string()
  .regex(/^[0-9]+(\.[0-9]+){0,2}$/, "must be a dotted numeric version");

/** Stable identifier used for scenarios, evaluators, protocols and categories. */
export const SlugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be lowercase kebab-case");

export const AgentCategorySchema = z.enum(["REBALANCING", "GRID", "YIELD", "HEALTH_FACTOR"]);
export type AgentCategory = z.infer<typeof AgentCategorySchema>;

/**
 * Spend periods.
 *
 * These are CALENDAR-ALIGNED BUCKETS, not rolling windows. Verified against the
 * deployed BSC account implementation: `startOfSpendPeriod` truncates to the UTC
 * minute/hour/day, to the preceding Monday for a week, to the 1st for a month
 * and to 1 January for a year, and the accumulated total hard-resets when the
 * bucket rolls over.
 *
 * The practical consequence has to be stated wherever a limit is displayed: a
 * `day` cap permits the full limit at 23:59 UTC and the full limit again at
 * 00:01 UTC. Describing that as a "rolling 24-hour limit" would be false, so
 * MANDATE says "per UTC day" and discloses the boundary.
 */
export const SpendPeriodSchema = z.enum(["minute", "hour", "day", "week", "month", "year"]);
export type SpendPeriod = z.infer<typeof SpendPeriodSchema>;

/**
 * Nominal length of each period in seconds.
 *
 * For display and estimation only. `month` and `year` are not constant lengths,
 * and these values must never be used to decide whether one period contains
 * another — use `spendPeriodContains` for that.
 */
export const SPEND_PERIOD_SECONDS: Record<SpendPeriod, number> = {
  minute: 60,
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
};

/**
 * Which periods each bucket provably contains.
 *
 * Containment, not duration, is what makes a spend comparison sound. Every
 * calendar day sits inside exactly one calendar week, so a `week` cap of L
 * bounds any single day at L. A calendar WEEK does not sit inside a calendar
 * month — a week straddling the 1st touches two month buckets — so a `month`
 * cap of L permits 2L inside one week, and `month` therefore does not contain
 * `week`.
 *
 * Getting this wrong is not academic: comparing durations would accept a
 * `100 per month` grant against a `100 per week` trial and silently permit
 * double the tested burst.
 */
const SPEND_PERIOD_DESCENDANTS: Record<SpendPeriod, readonly SpendPeriod[]> = {
  minute: [],
  hour: ["minute"],
  day: ["hour", "minute"],
  week: ["day", "hour", "minute"],
  month: ["day", "hour", "minute"],
  year: ["month", "day", "hour", "minute"],
};

/**
 * True when every `inner` bucket falls entirely within one `outer` bucket.
 *
 * Reflexive: a period contains itself. `week` and `month` are incomparable in
 * both directions.
 */
export function spendPeriodContains(outer: SpendPeriod, inner: SpendPeriod): boolean {
  return outer === inner || SPEND_PERIOD_DESCENDANTS[outer].includes(inner);
}

export function uint256ToBigInt(value: Uint256String): bigint {
  return BigInt(value);
}

export function bigIntToUint256(value: bigint): Uint256String {
  if (value < 0n) throw new RangeError(`uint256 cannot be negative: ${value}`);
  if (value > (1n << 256n) - 1n) throw new RangeError(`value exceeds uint256: ${value}`);
  return value.toString(10);
}

/** Normalise an address the way every canonical document stores it. */
export function normalizeAddress(value: string): Address {
  return getAddress(value).toLowerCase() as Address;
}

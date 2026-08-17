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
 * Rolling spend periods.
 *
 * These mirror the periods an enforcement layer can express. MANDATE never
 * invents a period the enforcement layer cannot actually apply, because an
 * unenforceable period would make the displayed authority a claim rather than a
 * boundary.
 */
export const SpendPeriodSchema = z.enum(["minute", "hour", "day", "week", "month", "year"]);
export type SpendPeriod = z.infer<typeof SpendPeriodSchema>;

/** Length of each rolling spend period in seconds. */
export const SPEND_PERIOD_SECONDS: Record<SpendPeriod, number> = {
  minute: 60,
  hour: 3_600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
};

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

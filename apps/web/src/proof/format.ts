/**
 * Turning machine values into something a reader can check by eye.
 *
 * Every function here is lossy on purpose, and every one of them is paired in
 * the UI with the full value it abbreviates. A truncated hash that cannot be
 * expanded is decoration; a truncated hash next to the whole string is a
 * reading aid.
 */
import type { Address, Hex } from "viem";

/** `0xb62599…35e929`. Always rendered beside the full value, never instead of it. */
export function shortHash(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function shortAddress(value: Address): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** `M-2392e1`, the label PRD §84 prints. Display only: nothing resolves a mandate by it. */
export function mandateLabel(mandateId: Hex): string {
  return `M-${mandateId.slice(2, 8)}`;
}

export function receiptLabel(receiptId: Hex): string {
  return `R-${receiptId.slice(2, 8)}`;
}

/**
 * Raw token units to a decimal string.
 *
 * Written out rather than taken from viem's `formatUnits` so the trailing zeros
 * are trimmed the way a spend cap should read: `25` rather than `25.000000`.
 */
export function formatUnits(raw: string, decimals: number): string {
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction.length === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

const UTC_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Always UTC, always labelled.
 *
 * The spend window is a UTC calendar bucket, so rendering any timestamp on this
 * page in the reader's local zone would put the cap boundary in one zone and
 * the events in another.
 */
export function formatUtc(unixSeconds: number): string {
  return `${UTC_FORMAT.format(new Date(unixSeconds * 1000)).replace(",", "")} UTC`;
}

export function formatIsoUtc(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** `7 days`, `24 hours`. Used for lifetimes, where a raw second count tells a reader nothing. */
export function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * The spend period, said the way the contract means it.
 *
 * "per UTC day" and never "rolling". The account's bucket is calendar-aligned
 * and hard-resets at midnight UTC, so "rolling" would promise a trailing window
 * the enforcement layer does not implement, and would understate the cap right
 * after a reset.
 */
export function formatSpendPeriod(period: string): string {
  switch (period) {
    case "day":
      return "per UTC day";
    case "hour":
      return "per UTC hour";
    case "week":
      return "per UTC week";
    default:
      return `per ${period}`;
  }
}

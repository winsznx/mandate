/**
 * MANDATE Canonical JSON — encoding `MCJ/1`.
 *
 * Every hash MANDATE commits to a public registry is taken over bytes produced
 * here, so the encoding is a frozen part of the protocol rather than an
 * implementation detail. It is deliberately a strict subset of RFC 8785 (JCS):
 * floats and large integers are rejected outright, which removes the only part
 * of JCS that is awkward to reproduce outside JavaScript. A verifier written in
 * Python reproduces it with
 * `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
 *
 * Rules:
 *  1. Values are limited to object, array, string, integer number, boolean, null.
 *  2. Object properties whose value is `undefined` are dropped before encoding.
 *  3. Object keys are sorted ascending by UTF-16 code unit (JCS ordering).
 *  4. No insignificant whitespace.
 *  5. Numbers must be safe integers. Anything wider travels as a decimal string.
 *  6. Output is UTF-8.
 */
import { keccak256, toHex } from "viem";
import type { Hex } from "viem";

export const CANONICAL_ENCODING_VERSION = "MCJ/1" as const;

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

export class CanonicalEncodingError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path || "$"})`);
    this.name = "CanonicalEncodingError";
    this.path = path;
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function encodeValue(value: CanonicalValue, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "string":
      return JSON.stringify(value);

    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalEncodingError(`Non-finite number ${String(value)}`, path);
      }
      if (!Number.isInteger(value)) {
        throw new CanonicalEncodingError(
          `Non-integer number ${value}; encode fractional values as strings`,
          path,
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalEncodingError(
          `Integer ${value} exceeds the safe range; encode wide integers as decimal strings`,
          path,
        );
      }
      // Object.is separates -0 from 0 so the encoding stays injective.
      return Object.is(value, -0) ? "0" : String(value);
    }

    case "bigint":
      throw new CanonicalEncodingError(
        "bigint is not directly encodable; convert to a decimal string first",
        path,
      );

    case "undefined":
      throw new CanonicalEncodingError("undefined is only allowed as an object property value", path);

    case "object":
      break;

    default:
      throw new CanonicalEncodingError(`Unsupported type ${describe(value)}`, path);
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new CanonicalEncodingError("Circular reference", path);
  }
  seen.add(object);

  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) => {
        if (item === undefined) {
          throw new CanonicalEncodingError("undefined is not allowed inside an array", `${path}[${index}]`);
        }
        return encodeValue(item, `${path}[${index}]`, seen);
      });
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalEncodingError(
        `Only plain objects are encodable, received ${(value as object).constructor?.name ?? "unknown"}`,
        path,
      );
    }

    const record = value as Record<string, CanonicalValue | undefined>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();

    const entries = keys.map((key) => {
      const encoded = encodeValue(record[key] as CanonicalValue, `${path}.${key}`, seen);
      return `${JSON.stringify(key)}:${encoded}`;
    });

    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/** Encode a value as the canonical UTF-8 JSON string used for every MANDATE hash. */
export function canonicalize(value: CanonicalValue): string {
  if (value === undefined) {
    throw new CanonicalEncodingError("Cannot canonicalize undefined", "");
  }
  return encodeValue(value, "$", new Set());
}

/** UTF-8 bytes of the canonical encoding. */
export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/**
 * keccak256 over the canonical UTF-8 bytes.
 *
 * keccak256 rather than sha256 so a hash produced here can be compared against
 * one produced inside a Solidity test without a second hash function.
 */
export function canonicalHash(value: CanonicalValue): Hex {
  return keccak256(toHex(canonicalBytes(value)));
}

/**
 * Round-trip a value through the canonical encoding.
 *
 * Useful when a document is about to be stored or transmitted and must be
 * byte-identical to the form that was hashed.
 */
export function canonicalClone<T extends CanonicalValue>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

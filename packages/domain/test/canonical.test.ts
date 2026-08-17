import { describe, expect, it } from "vitest";
import {
  CanonicalEncodingError,
  canonicalHash,
  canonicalize,
  type CanonicalValue,
} from "../src/canonical.js";

describe("canonicalize", () => {
  it("sorts object keys by UTF-16 code unit", () => {
    // #given a document whose keys are declared out of order
    const document: CanonicalValue = { b: 1, a: 2, C: 3, "é": 4, A: 5 };

    // #when it is canonicalised
    const encoded = canonicalize(document);

    // #then keys appear in ascending code-unit order
    expect(encoded).toBe('{"A":5,"C":3,"a":2,"b":1,"é":4}');
  });

  it("sorts keys at every depth", () => {
    // #given nesting inside both an object and an array
    const document: CanonicalValue = { z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] };

    // #when it is canonicalised
    const encoded = canonicalize(document);

    // #then every level is sorted
    expect(encoded).toBe('{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}');
  });

  it("drops properties whose value is undefined", () => {
    // #given an optional field left unset
    const document = { a: 1, b: undefined, c: 3 };

    // #when it is canonicalised
    const encoded = canonicalize(document);

    // #then the absent field leaves no trace
    expect(encoded).toBe('{"a":1,"c":3}');
  });

  it("keeps an explicit null, which is not the same as an absent key", () => {
    // #given a field explicitly set to null
    // #when it is canonicalised
    // #then null survives
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it("emits no insignificant whitespace", () => {
    // #given nested containers
    // #when canonicalised
    // #then the output is compact
    expect(canonicalize({ a: [1, 2, 3], b: { c: true } })).toBe('{"a":[1,2,3],"b":{"c":true}}');
  });

  it("preserves array order, which carries meaning", () => {
    // #given an array that is not sorted
    // #when canonicalised
    // #then its order is untouched
    expect(canonicalize(["c", "a", "b"])).toBe('["c","a","b"]');
  });

  it("normalises negative zero so the encoding stays injective", () => {
    // #given the two spellings of zero
    // #when both are canonicalised
    // #then they collapse to one representation
    expect(canonicalize({ a: -0 })).toBe(canonicalize({ a: 0 }));
  });

  it("writes non-ASCII as literal UTF-8 rather than escapes", () => {
    // #given a string with multi-byte characters
    // #when canonicalised
    // #then the characters survive unescaped
    expect(canonicalize({ k: "café → 日本" })).toBe('{"k":"café → 日本"}');
  });

  it("escapes quotes, backslashes and control characters", () => {
    // #given a string containing each class of character JSON must escape
    const document = { k: 'a"b\\c\nd' };

    // #when canonicalised
    const encoded = canonicalize(document);

    // #then each is escaped exactly once
    expect(encoded).toBe('{"k":"a\\"b\\\\c\\nd"}');
  });

  it("produces one encoding for two objects built in different key orders", () => {
    // #given the same document assembled two ways
    const first: CanonicalValue = { alpha: 1, beta: { x: 1, y: 2 } };
    const second: CanonicalValue = { beta: { y: 2, x: 1 }, alpha: 1 };

    // #when both are canonicalised
    // #then they agree byte for byte
    expect(canonicalize(first)).toBe(canonicalize(second));
  });
});

describe("canonicalize rejects values it cannot encode deterministically", () => {
  it("rejects a fractional number", () => {
    // #given a float, whose shortest round-trip spelling varies between languages
    // #when canonicalised
    // #then it is refused
    expect(() => canonicalize({ a: 1.5 })).toThrow(CanonicalEncodingError);
  });

  it("rejects an integer beyond the safe range", () => {
    // #given an integer that cannot round-trip through a JSON number
    // #when canonicalised
    // #then it is refused, pointing at the decimal-string encoding
    expect(() => canonicalize({ a: 2 ** 53 })).toThrow(/safe range/);
  });

  it("rejects NaN", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(/Non-finite/);
  });

  it("rejects Infinity", () => {
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(/Non-finite/);
  });

  it("rejects bigint and names the supported alternative", () => {
    // #given a bigint, which has no JSON representation
    // #when canonicalised
    // #then the error directs the caller to decimal strings
    expect(() => canonicalize({ a: 1n } as unknown as CanonicalValue)).toThrow(/decimal string/);
  });

  it("rejects undefined inside an array, where dropping it would shift indices", () => {
    expect(() => canonicalize([1, undefined, 3] as unknown as CanonicalValue)).toThrow(
      /not allowed inside an array/,
    );
  });

  it("rejects a class instance, whose fields are not the whole value", () => {
    expect(() => canonicalize({ a: new Date(0) } as unknown as CanonicalValue)).toThrow(
      /plain objects/,
    );
  });

  it("rejects a circular structure instead of recursing forever", () => {
    // #given a node that points at itself
    const node: Record<string, unknown> = { a: 1 };
    node.self = node;

    // #when canonicalised
    // #then the cycle is reported
    expect(() => canonicalize(node as CanonicalValue)).toThrow(/Circular/);
  });

  it("names the path of the offending value", () => {
    // #given an unencodable value buried in the document
    // #when canonicalised
    // #then the error locates it
    expect(() => canonicalize({ outer: { inner: [0, 1.5] } })).toThrow(/\$\.outer\.inner\[1\]/);
  });
});

describe("canonicalHash", () => {
  it("agrees across independent constructions of one document", () => {
    // #given an authority fragment written in two key orders
    const document: CanonicalValue = {
      schemaVersion: "mandate.authority-ir/1",
      chainId: 97,
      spend: [
        {
          token: "0x55d398326f99059ff775485246999027b3197955",
          limit: "25000000000000000000",
          period: "day",
        },
      ],
    };
    const reordered: CanonicalValue = {
      spend: [
        {
          period: "day",
          limit: "25000000000000000000",
          token: "0x55d398326f99059ff775485246999027b3197955",
        },
      ],
      chainId: 97,
      schemaVersion: "mandate.authority-ir/1",
    };

    // #when both are hashed
    // #then the hashes match
    expect(canonicalHash(document)).toBe(canonicalHash(reordered));
  });

  it("changes when a spend limit changes by one base unit", () => {
    // #given two limits differing in the last digit
    // #when both are hashed
    // #then the hashes differ
    expect(canonicalHash({ limit: "25000000000000000000" })).not.toBe(
      canonicalHash({ limit: "25000000000000000001" }),
    );
  });

  it("distinguishes an absent key from a null one", () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 1, b: null }));
  });

  it("distinguishes an empty object from an empty array", () => {
    expect(canonicalHash({})).not.toBe(canonicalHash([]));
  });

  it("returns 32 bytes of lowercase hex", () => {
    expect(canonicalHash({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

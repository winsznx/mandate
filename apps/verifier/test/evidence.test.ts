import { describe, expect, it } from "vitest";
import { canonicalBytes, canonicalize } from "@mandate/domain/canonical";
import type { CanonicalValue } from "@mandate/domain/canonical";
import { keccak256, toHex } from "viem";
import { checkEvidenceIntegrity } from "../src/evidence.js";
import { buildBundle } from "./fixtures.js";

const DOCUMENT = { b: "second", a: 1, nested: { z: true, y: [1, 2, 3] } };

function hashOf(value: CanonicalValue): `0x${string}` {
  return keccak256(toHex(canonicalBytes(value)));
}

describe("checkEvidenceIntegrity", () => {
  it("accepts bytes that are already the canonical encoding", () => {
    // #given a store that holds the exact canonical MCJ/1 byte string
    const bytes = canonicalBytes(DOCUMENT);

    // #when checked against the hash a receipt would commit to
    const result = checkEvidenceIntegrity(bytes, hashOf(DOCUMENT));

    // #then it passes and reports that no re-encoding was needed
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.encoding).toBe("CANONICAL_BYTES");
    expect(result.document).toEqual(DOCUMENT);
  });

  it("accepts a pretty-printed copy of the same value", () => {
    // #given the same document stored with indentation and a different key order
    const bytes = new TextEncoder().encode(
      JSON.stringify({ nested: { y: [1, 2, 3], z: true }, a: 1, b: "second" }, null, 2),
    );

    // #when checked against the canonical hash
    const result = checkEvidenceIntegrity(bytes, hashOf(DOCUMENT));

    // #then MCJ/1 re-encoding reconciles them, and the report says so
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.encoding).toBe("RECANONICALISED");
  });

  it("rejects a document that hashes to something else, and hands back nothing to read", () => {
    // #given evidence whose content was altered after publication
    const tampered = canonicalBytes({ ...DOCUMENT, a: 2 });

    // #when checked against the hash the receipt committed to
    const result = checkEvidenceIntegrity(tampered, hashOf(DOCUMENT));

    // #then it fails, names both hashes, and exposes no parsed document
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("evidence hash mismatch");
    expect(result.reason).toContain(hashOf(DOCUMENT));
    expect("document" in result).toBe(false);
  });

  it("rejects a body that is not JSON at all", () => {
    // #given bytes that are not a JSON document
    const bytes = new TextEncoder().encode("<html>404 not found</html>");

    // #when checked
    const result = checkEvidenceIntegrity(bytes, hashOf(DOCUMENT));

    // #then it fails without attempting to interpret anything
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not valid UTF-8 JSON");
  });

  it("rejects a document MCJ/1 cannot encode, and explains why", () => {
    // #given evidence carrying a float, which the canonical encoding forbids
    const bytes = new TextEncoder().encode('{"slippage":0.5}');

    // #when checked
    const result = checkEvidenceIntegrity(bytes, hashOf(DOCUMENT));

    // #then the failure names the encoding rule rather than a bare mismatch
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not MCJ/1-encodable");
  });

  it("passes a real trial bundle stored as its canonical bytes", () => {
    // #given the bundle a publisher would upload
    const bundle = buildBundle({ result: "PASS" });

    // #when checked against the hash that bundle commits to
    const result = checkEvidenceIntegrity(bundle.bytes, bundle.hash);

    // #then the stored object is byte-identical to what was hashed
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.encoding).toBe("CANONICAL_BYTES");
    expect(new TextDecoder().decode(bundle.bytes)).toBe(canonicalize(bundle.document as CanonicalValue));
  });
});

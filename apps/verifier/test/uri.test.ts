import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { EvidenceUnavailableError, fetchEvidenceBytes, resolveEvidenceUri } from "../src/uri.js";

const R2_BASE = "https://pub-example.r2.dev";

describe("resolveEvidenceUri", () => {
  it("passes an https URI through untouched", () => {
    // #given an ordinary web location
    // #when resolved
    const url = resolveEvidenceUri("https://evidence.example/trial-0001.json");

    // #then nothing is rewritten
    expect(url.href).toBe("https://evidence.example/trial-0001.json");
  });

  it("dereferences ipfs:// through a gateway", () => {
    // #given a CID and a chosen gateway
    // #when resolved
    const url = resolveEvidenceUri("ipfs://bafyfixture/trial.json", {
      ipfsGateway: "https://gateway.example/ipfs",
    });

    // #then the gateway path carries the CID
    expect(url.href).toBe("https://gateway.example/ipfs/bafyfixture/trial.json");
  });

  it("tolerates the ipfs://ipfs/ prefix some publishers emit", () => {
    // #given a doubled path segment
    // #when resolved
    const url = resolveEvidenceUri("ipfs://ipfs/bafyfixture", {
      ipfsGateway: "https://gateway.example/ipfs/",
    });

    // #then it resolves to the same object as the undoubled form
    expect(url.href).toBe("https://gateway.example/ipfs/bafyfixture");
  });

  it("maps r2:// onto a public base, without repeating the bucket", () => {
    // #given an R2 object and the bucket's public domain
    // #when resolved
    const url = resolveEvidenceUri("r2://mandate-evidence/trials/0001.json", { r2PublicBase: R2_BASE });

    // #then the bucket is not duplicated into the path
    expect(url.href).toBe("https://pub-example.r2.dev/trials/0001.json");
  });

  it("refuses r2:// with no public base rather than guessing a MANDATE bucket", () => {
    // #given no configured public base
    // #when resolved
    // #then it fails with an explanation the operator can act on
    expect(() => resolveEvidenceUri("r2://mandate-evidence/trials/0001.json", { r2PublicBase: "" })).toThrow(
      EvidenceUnavailableError,
    );
  });

  it("rejects a scheme it cannot dereference", () => {
    // #given a URI in an unknown scheme
    // #when resolved
    // #then it refuses instead of silently producing an unreachable URL
    expect(() => resolveEvidenceUri("s3://bucket/key")).toThrow(/unsupported URI scheme/);
  });
});

describe("fetchEvidenceBytes", () => {
  it("reads a local file, so a judge can verify from a downloaded copy", async () => {
    // #given evidence saved to disk
    const dir = await mkdtemp(join(tmpdir(), "mandate-verifier-"));
    const path = join(dir, "evidence.json");
    await writeFile(path, '{"a":1}');

    // #when fetched by file URI
    const bytes = await fetchEvidenceBytes(pathToFileURL(path).href);

    // #then the exact bytes come back
    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
  });

  it("reports an HTTP failure as unavailable rather than as a bad hash", async () => {
    // #given a host that answers 404
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;

    // #when fetched
    // #then the error names the transport problem, not the evidence
    await expect(
      fetchEvidenceBytes("https://evidence.example/missing.json", { fetchImpl }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

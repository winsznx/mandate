import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The contract records a `disclosureURI` on every activation so a judge holding
 * nothing but a mandate id can OBTAIN the granted AuthorityIR rather than
 * having to be handed one.
 *
 * That field was added to the contract and not to the verifier, so for a while
 * the chain carried the URI and the verifier still demanded `--disclosure`,
 * silently capping every unassisted verification. The two changes were made in
 * different sessions and nothing tied them together. This test is the tie.
 */
describe("the verifier resolves the disclosure from chain", () => {
  const source = readFileSync(new URL("../src/verify.ts", import.meta.url), "utf8");

  it("passes the activation's disclosureURI into the loader", () => {
    // #given the verifier's mandate path
    // #then it hands the on-chain URI to the loader rather than only the flag
    expect(source).toContain("loadDisclosure(options, activation.disclosureURI)");
  });

  it("falls back to the on-chain URI when no flag is supplied", () => {
    // #given the loader
    // #then the flag is an override, not the only source
    expect(source).toMatch(/options\.disclosureUri \?\? /);
  });

  it("no longer claims the chain stores no URI", () => {
    // #given the message that was left behind after the contract gained the field
    // #then it is gone, because it told a judge to do unnecessary work
    expect(source).not.toContain("stores no URI for the document");
  });

  it("still checks any disclosure against the on-chain hash", () => {
    // #given a document resolved from chain rather than passed by hand
    // #then resolving it from chain grants it no extra trust
    expect(source).toContain("authorityHash(disclosure.grantedAuthority)");
  });
});

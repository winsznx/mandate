import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { REGISTRY_ABI } from "../src/registry.js";

/**
 * The ABI in `registry.ts` is written out by hand so the verifier runs from a
 * checkout with no `forge build` behind it. That convenience has a cost: when
 * the contract gains a field, nothing makes the copy follow.
 *
 * It has already happened once. `disclosureURI` was added to `Activation` and
 * the verifier kept demanding the URI by flag for a while afterwards. This test
 * reads the struct out of the interface and compares it with the copy, so the
 * next field cannot be added on one side alone.
 */
function activationFieldsFromSolidity(): string[] {
  const source = readFileSync(
    new URL("../../../contracts/src/IMandateReceiptRegistry.sol", import.meta.url),
    "utf8",
  );
  const body = /struct Activation \{([\s\S]*?)\n {4}\}/.exec(source)?.[1];
  if (body === undefined) throw new Error("no Activation struct in IMandateReceiptRegistry.sol");

  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(";"))
    .map((line) => {
      const field = /^([A-Za-z0-9\[\]]+)\s+([A-Za-z0-9_]+);$/.exec(line);
      if (field === null) throw new Error(`unparsed Activation field: '${line}'`);
      return `${field[1]} ${field[2]}`;
    });
}

function activationFieldsFromAbi(): string[] {
  const entry = REGISTRY_ABI.find((item) => item.name === "getActivation");
  const components = entry?.outputs?.[0]?.components;
  if (components === undefined) throw new Error("getActivation carries no tuple in the inlined ABI");
  return components.map((component) => `${component.type} ${component.name}`);
}

describe("the inlined registry ABI", () => {
  it("describes the Activation struct the contract actually stores", () => {
    // #given the struct as the interface declares it
    const solidity = activationFieldsFromSolidity();

    // #when compared with the copy the verifier decodes with
    const abi = activationFieldsFromAbi();

    // #then they agree field for field and in order, because ABI decoding is
    // positional and a shifted field would be read as a different value rather
    // than as an error
    expect(abi).toEqual(solidity);
  });

  it("carries the lifecycle fields a finished mandate is reconstructed from", () => {
    // #given the decoded shape
    const abi = activationFieldsFromAbi();

    // #then the window and the revocation are present, without which a revoked
    // mandate is indistinguishable from one that was never granted
    expect(abi).toContain("uint64 validFrom");
    expect(abi).toContain("uint64 validUntil");
    expect(abi).toContain("uint64 revokedAt");
  });
});

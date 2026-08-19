import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { REGISTRY_ABI } from "../src/proof/registry";
import { RECEIPT_REGISTRY } from "../src/proof/config";

/**
 * The page carries its own copy of the registry ABI so it is servable from a
 * checkout with no `forge build` behind it, and its own copy of the registry
 * address so it needs no deploy tooling at request time. Both copies can drift.
 *
 * They already did once: `disclosureURI` reached the contract before it reached
 * the readers of it. These tests tie the copies to the files that own the
 * truth, so the next field or the next redeployment cannot land on one side
 * alone.
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

describe("the inlined registry ABI", () => {
  it("describes the Activation struct the contract actually stores", () => {
    // #given the struct as the interface declares it
    const solidity = activationFieldsFromSolidity();

    // #when compared with the copy the page decodes with
    const entry = REGISTRY_ABI.find((item) => item.name === "getActivation");
    const abi = (entry?.outputs?.[0]?.components ?? []).map(
      (component) => `${component.type} ${component.name}`,
    );

    // #then they agree field for field and in order, because ABI decoding is
    // positional and a shifted field reads as a different value rather than as
    // an error
    expect(abi).toEqual(solidity);
  });
});

describe("the registry address", () => {
  it("is the one the deployment manifest records", () => {
    // #given the deployment the contracts package published
    const deployment = JSON.parse(
      readFileSync(new URL("../../../contracts/deployments/97.json", import.meta.url), "utf8"),
    ) as { address: string };

    // #then the page reads the live registry. A page still pointed at a
    // superseded one renders abandoned evidence as current, which is quieter
    // and worse than a page that cannot find a mandate at all.
    expect(RECEIPT_REGISTRY).toBe(deployment.address.toLowerCase());
  });
});

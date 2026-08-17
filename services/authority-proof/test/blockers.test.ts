import { describe, expect, it } from "vitest";
import {
  fatalBlocker,
  haltsRun,
  primaryBlocker,
  renderBlocked,
  writeBlocker,
} from "../src/phase7/blockers.js";

const BSC_TESTNET = { name: "BSC Testnet", chainId: 97 };

describe("the refusal stanza", () => {
  it("renders the underfunded case exactly as the operator contract specifies", () => {
    // #given a deployer whose balance cannot cover the sequence
    const blocker = writeBlocker("INSUFFICIENT_DEPLOYER_BALANCE", [
      ["address", "0x1111111111111111111111111111111111111111"],
      ["balance", "1000000000000000 wei (0.001 tBNB)"],
      ["required", "20000000000000000 wei (0.02 tBNB)"],
    ]);

    // #when the run stops
    const rendered = renderBlocked(blocker, BSC_TESTNET);

    // #then the text is fixed, so it stays greppable across logs and
    // screenshots and an operator never has to interpret a template
    expect(rendered).toBe(
      [
        "BLOCKED",
        "reason: INSUFFICIENT_DEPLOYER_BALANCE",
        "network: BSC Testnet (97)",
        "address: 0x1111111111111111111111111111111111111111",
        "balance: 1000000000000000 wei (0.001 tBNB)",
        "required: 20000000000000000 wei (0.02 tBNB)",
      ].join("\n"),
    );
  });

  it("keeps the first three lines identical for every other reason", () => {
    // #given a completely different blocker
    const rendered = renderBlocked(
      fatalBlocker("PINNED_CONTRACT_CHANGED", [["contract", "Altana KeyStore"]]),
      BSC_TESTNET,
    );

    // #then only the detail below the header varies
    expect(rendered.split("\n").slice(0, 3)).toEqual([
      "BLOCKED",
      "reason: PINNED_CONTRACT_CHANGED",
      "network: BSC Testnet (97)",
    ]);
  });
});

describe("choosing which blocker to report", () => {
  it("reports a run-halting blocker ahead of a missing input", () => {
    // #given a run with both a redeployed contract and no key
    const blockers = [
      writeBlocker("MISSING_DEPLOYER_KEY", []),
      fatalBlocker("VENUS_IMPLEMENTATION_CHANGED", []),
    ];

    // #then the one that invalidates the whole run wins, because funding a key
    // would not make the run meaningful
    expect(primaryBlocker(blockers)?.reason).toBe("VENUS_IMPLEMENTATION_CHANGED");
  });

  it("reports the first missing input when nothing invalidates the run", () => {
    // #given only write-lane blockers
    const blockers = [
      writeBlocker("MISSING_DEPLOYER_KEY", []),
      writeBlocker("MISSING_RECEIPT_REGISTRY", []),
    ];

    // #then the order the checks ran in decides, which is why that order is
    // part of the preflight contract
    expect(primaryBlocker(blockers)?.reason).toBe("MISSING_DEPLOYER_KEY");
    expect(haltsRun(blockers)).toBe(false);
  });

  it("lets the read-only lane continue when only writes are blocked", () => {
    // #given a run with no key
    // #then nothing stops the trial, the replay or the evidence bundle
    expect(haltsRun([writeBlocker("MISSING_DEPLOYER_KEY", [])])).toBe(false);
  });
});

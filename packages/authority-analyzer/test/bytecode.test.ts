import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { exposesSelector, scanOpcodes, selectorOf } from "../src/bytecode.js";

/** `PUSH4 <selector>`, the shape a Solidity dispatcher compiles a function into. */
function push4(selector: string): string {
  return `63${selector}`;
}

describe("walking runtime bytecode", () => {
  it("does not mistake a byte inside a PUSH immediate for an opcode", () => {
    // #given a PUSH32 whose constant contains 0xf4, 0xf2, 0xff and 0xf1
    const constant = "f4f2fff1".repeat(8);
    const scan = scanOpcodes(`0x7f${constant}` as Hex);

    // #then none of them is reported. A false delegatecall downgrades a correct
    // DIRECT_SAFE verdict to GUARD_REQUIRED, and a false negative does the
    // reverse, which is the more dangerous direction.
    expect(scan.delegateCall).toBe(false);
    expect(scan.callCode).toBe(false);
    expect(scan.selfDestruct).toBe(false);
    expect(scan.externalCall).toBe(false);
  });

  it("reports the opcodes that really are opcodes", () => {
    // #given a delegatecall and a selfdestruct outside any immediate
    const scan = scanOpcodes("0x60016002f4ff" as Hex);

    // #then both are seen
    expect(scan.delegateCall).toBe(true);
    expect(scan.selfDestruct).toBe(true);
  });

  it("treats CREATE and CREATE2 as the same capability", () => {
    // #then either one means the contract can deploy code
    expect(scanOpcodes("0xf0" as Hex).create).toBe(true);
    expect(scanOpcodes("0xf5" as Hex).create).toBe(true);
  });
});

describe("selector dispatch", () => {
  it("finds a selector the dispatcher pushes", () => {
    // #given a dispatcher fragment for repayBorrow(uint256)
    const facts = {
      address: "0x0000000000000000000000000000000000000001" as const,
      runtimeCode: `0x${push4("0e752702")}${push4("c5ebeaec")}` as Hex,
      runtimeCodeHash: `0x${"0".repeat(64)}` as Hex,
      sizeBytes: 10,
      scan: scanOpcodes(`0x${push4("0e752702")}${push4("c5ebeaec")}` as Hex),
    };

    // #then the granted selector is confirmed present in the deployed code,
    // which is the difference between granting a call the contract answers and
    // granting one it silently falls through on
    expect(exposesSelector(facts, "0x0e752702")).toBe(true);
    expect(exposesSelector(facts, "0x0E752702")).toBe(true);
    expect(exposesSelector(facts, "0x2608f818")).toBe(false);
  });

  it("reads the selector off calldata, and refuses a stub too short to have one", () => {
    // #given full calldata and a three-byte fragment
    // #then a fragment yields nothing rather than a truncated guess
    expect(selectorOf(`0x0e752702${"0".repeat(64)}` as Hex)).toBe("0x0e752702");
    expect(selectorOf("0x0e7527" as Hex)).toBeUndefined();
  });
});

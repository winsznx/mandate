import { describe, expect, it } from "vitest";
import { encodeAbiParameters } from "viem";
import type { Hex } from "viem";
import { decodeRevert, isPolicyRejection } from "../src/revert-decoder.js";

const USDT = "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c";

function exceededSpendLimit(token: string): Hex {
  return `0x9054c912${encodeAbiParameters([{ type: "address" }], [token as `0x${string}`]).slice(2)}`;
}

/** Encode a Solidity `Error(string)` revert the way a protocol emits one. */
function solidityError(message: string): Hex {
  const encoded = encodeAbiParameters([{ type: "string" }], [message]);
  return `0x08c379a0${encoded.slice(2)}`;
}

describe("decodeRevert", () => {
  it("classifies a spend-cap rejection as the policy working", () => {
    // #given the account's own spend guard rejecting the call
    const data = exceededSpendLimit(USDT);

    // #when decoded
    const decoded = decodeRevert(data);

    // #then it is attributed to the policy, with the token named
    expect(decoded.class).toBe("POLICY_BLOCKED");
    expect(decoded.name).toBe("ExceededSpendLimit");
    expect(decoded.token).toBe(USDT);
    expect(isPolicyRejection(decoded)).toBe(true);
  });

  /**
   * The failure that most convincingly impersonates a spend-cap rejection.
   * Both stop the transaction; only one demonstrates bounded authority. A demo
   * that confuses them is proving a misconfiguration.
   */
  it("separates an exhausted token allowance from a spend-cap rejection", () => {
    // #given the standing allowance running out mid-mandate
    const data = solidityError("BEP20: transfer amount exceeds allowance");

    // #when decoded
    const decoded = decodeRevert(data);

    // #then it is a MANDATE configuration fault, not a policy rejection
    expect(decoded.class).toBe("ALLOWANCE_INSUFFICIENT");
    expect(isPolicyRejection(decoded)).toBe(false);
    expect(decoded.reason).toContain("not the spend cap");
  });

  it("classifies an out-of-scope call as a policy rejection", () => {
    // #given the account refusing a target or selector the session lacks
    const decoded = decodeRevert("0xf78c1b53");

    // #then it counts toward a proof of bounded authority
    expect(decoded.name).toBe("UnauthorizedCall");
    expect(isPolicyRejection(decoded)).toBe(true);
  });

  it("classifies spending a token with no permission as a policy rejection", () => {
    const decoded = decodeRevert("0x5ee7e5b1");
    expect(decoded.name).toBe("NoSpendPermissions");
    expect(isPolicyRejection(decoded)).toBe(true);
  });

  it("classifies a self-execute attempt as a policy rejection", () => {
    // #given a session trying to call the account itself to widen its own rules
    const decoded = decodeRevert("0x0e9be31c");

    // #then the escalation is refused by the account, not by MANDATE
    expect(decoded.name).toBe("CannotSelfExecute");
    expect(isPolicyRejection(decoded)).toBe(true);
  });

  it("classifies a revoked or absent key as an invalid session, not a policy block", () => {
    // #given a key the account no longer holds
    const decoded = decodeRevert("0xe57b6304");

    // #then it is a session-state fault. It proves revocation worked, but it is
    // not evidence that a scope boundary held.
    expect(decoded.class).toBe("SESSION_INVALID");
    expect(isPolicyRejection(decoded)).toBe(false);
  });

  it("classifies an ordinary protocol revert as neither policy nor allowance", () => {
    const decoded = decodeRevert(solidityError("Venus: repay amount exceeds borrow balance"));
    expect(decoded.class).toBe("PROTOCOL_REVERT");
    expect(decoded.reason).toContain("Venus");
    expect(isPolicyRejection(decoded)).toBe(false);
  });

  it("reports empty revert data as unknown rather than guessing", () => {
    const decoded = decodeRevert("0x");
    expect(decoded.class).toBe("UNKNOWN");
    expect(isPolicyRejection(decoded)).toBe(false);
  });

  it("reports an unrecognised selector as unknown and quotes it", () => {
    // #given a revert from a contract MANDATE has no ABI for
    const decoded = decodeRevert("0xdeadbeef");

    // #then it is not silently attributed to the policy
    expect(decoded.class).toBe("UNKNOWN");
    expect(isPolicyRejection(decoded)).toBe(false);
  });

  it("preserves the raw data so evidence can quote what the chain returned", () => {
    const data = exceededSpendLimit(USDT);
    expect(decodeRevert(data).raw).toBe(data);
  });
});

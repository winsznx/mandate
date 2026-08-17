/**
 * Turning a bare failure into a reason.
 *
 * The SDK returns `{ status: "FAILED" }` with no revert string, no error code
 * and no receipt. For MANDATE that is not merely inconvenient: the headline
 * proof is a rejection, and a rejection nobody can attribute proves nothing.
 * "The spend cap stopped it" and "the wallet was out of gas" look identical
 * from the SDK's return value.
 *
 * The distinction that matters most is `ExceededSpendLimit` against an ERC-20
 * allowance failure. Both stop the same transaction. Only one of them is the
 * product working, and a demo that mistakes the second for the first is
 * demonstrating a misconfiguration.
 */
import { decodeErrorResult, slice } from "viem";
import type { Hex } from "viem";
import { REVERT_SELECTORS, type RevertSelector } from "./constants.js";

export const ACCOUNT_ERROR_ABI = [
  { type: "error", name: "ExceededSpendLimit", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "NoSpendPermissions", inputs: [] },
  {
    type: "error",
    name: "UnauthorizedCall",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
  },
  { type: "error", name: "KeyDoesNotExist", inputs: [] },
  { type: "error", name: "CannotSelfExecute", inputs: [] },
] as const;

/**
 * What stopped the call, in terms MANDATE can act on.
 *
 * `POLICY_BLOCKED` is the enforcement layer doing its job and is the only class
 * that belongs in a proof of bounded authority. Everything else is a fault, and
 * conflating the two would let a broken demo look like a successful one.
 */
export type RevertClass =
  | "POLICY_BLOCKED"
  | "ALLOWANCE_INSUFFICIENT"
  | "PROTOCOL_REVERT"
  | "SESSION_INVALID"
  | "UNKNOWN";

export interface DecodedRevert {
  class: RevertClass;
  /** Contract-level error name when one was recognised. */
  name?: string;
  /** Human-readable explanation suitable for the execution timeline. */
  reason: string;
  /** For `ExceededSpendLimit`, the token whose cap was hit. */
  token?: string;
  selector?: Hex;
  raw: Hex;
}

/**
 * Revert strings that mean "the standing allowance ran out".
 *
 * Recognised explicitly because this is the failure that most convincingly
 * impersonates a spend-cap rejection. Venus repays pull the underlying with
 * `transferFrom`, so an allowance sized to the daily cap rather than to the
 * mandate's lifetime budget produces this instead of `ExceededSpendLimit` — the
 * demo appears to work while proving the wrong thing.
 */
const ALLOWANCE_PATTERNS = [
  "transfer amount exceeds allowance",
  "insufficient allowance",
  "ERC20: insufficient allowance",
];

const SOLIDITY_ERROR_SELECTOR = "0x08c379a0";

function decodeSolidityErrorString(data: Hex): string | undefined {
  try {
    const decoded = decodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      data,
    });
    return decoded.args?.[0] as string | undefined;
  } catch {
    return undefined;
  }
}

/** Classify raw revert data returned by a failed call. */
export function decodeRevert(data: Hex): DecodedRevert {
  if (data === "0x" || data.length < 10) {
    return {
      class: "UNKNOWN",
      reason: "The call reverted without returning any data",
      raw: data,
    };
  }

  const selector = slice(data, 0, 4).toLowerCase() as Hex;

  if (selector === SOLIDITY_ERROR_SELECTOR) {
    const message = decodeSolidityErrorString(data) ?? "";
    const isAllowance = ALLOWANCE_PATTERNS.some((pattern) =>
      message.toLowerCase().includes(pattern.toLowerCase()),
    );
    return {
      class: isAllowance ? "ALLOWANCE_INSUFFICIENT" : "PROTOCOL_REVERT",
      name: "Error",
      reason: isAllowance
        ? `The standing token allowance was too small: "${message}". This is a MANDATE configuration fault, not the spend cap.`
        : message || "The protocol reverted without a message",
      selector,
      raw: data,
    };
  }

  const known = REVERT_SELECTORS[selector as RevertSelector];
  if (known === undefined) {
    return {
      class: "UNKNOWN",
      reason: `Unrecognised revert selector ${selector}`,
      selector,
      raw: data,
    };
  }

  const name = known.slice(0, known.indexOf("("));

  if (name === "ExceededSpendLimit") {
    let token: string | undefined;
    try {
      const decoded = decodeErrorResult({ abi: ACCOUNT_ERROR_ABI, data });
      token = (decoded.args?.[0] as string | undefined)?.toLowerCase();
    } catch {
      token = undefined;
    }
    return {
      class: "POLICY_BLOCKED",
      name,
      reason:
        "The account's spend cap rejected this call. The cumulative amount for the current period would have exceeded the granted limit.",
      ...(token === undefined ? {} : { token }),
      selector,
      raw: data,
    };
  }

  const policyReasons: Record<string, { class: RevertClass; reason: string }> = {
    NoSpendPermissions: {
      class: "POLICY_BLOCKED",
      reason:
        "The session holds no spend permission for this token, so it may not move it at any amount.",
    },
    UnauthorizedCall: {
      class: "POLICY_BLOCKED",
      reason: "The session is not permitted to call this contract and method.",
    },
    CannotSelfExecute: {
      class: "POLICY_BLOCKED",
      reason: "A session may never call the account itself, so it cannot alter its own permissions.",
    },
    KeyDoesNotExist: {
      class: "SESSION_INVALID",
      reason: "The account holds no such key. The session was revoked or never granted.",
    },
  };

  const mapped = policyReasons[name];
  return {
    class: mapped?.class ?? "UNKNOWN",
    name,
    reason: mapped?.reason ?? `The account rejected the call with ${known}`,
    selector,
    raw: data,
  };
}

/**
 * True when the revert is the enforcement layer refusing an out-of-scope action.
 *
 * A proof of bounded authority may only count a rejection that returns true
 * here. Anything else is a fault dressed as a success.
 */
export function isPolicyRejection(decoded: DecodedRevert): boolean {
  return decoded.class === "POLICY_BLOCKED";
}

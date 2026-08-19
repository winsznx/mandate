/**
 * Three outcomes, not two.
 *
 * The SDK resolves with a status when a call is mined and THROWS when the
 * account contract refuses it. Collapsing those into one exception path loses
 * the distinction the whole product rests on:
 *
 *   SUCCESS              the action completed
 *   EXPECTED_REJECTION   the policy boundary held — the product working
 *   UNEXPECTED_FAILURE   infrastructure, protocol or runtime broke
 *
 * A rejected execution is not an application failure. A crashed run and a
 * proven boundary are indistinguishable from an exit code, and only one of them
 * is evidence. Every execution in the proof sequence goes through here so that
 * distinction is made once rather than at each call site.
 *
 * The throw is richer than the resolved value: viem carries the decoded custom
 * error, so `ExceededSpendLimit` is recoverable from the exception itself even
 * when the relay never surfaces raw revert bytes for a receipt lookup. That was
 * the failure mode most likely to need adjustment on the first funded run.
 */
import type { Hex } from "viem";

export type ExecutionOutcome = "SUCCESS" | "EXPECTED_REJECTION" | "UNEXPECTED_FAILURE";

export interface ExecutionResult {
  outcome: ExecutionOutcome;
  status: string;
  callsId?: string;
  transactionHash?: Hex;
  /** Custom error the account raised, e.g. `ExceededSpendLimit`. */
  rejectionName?: string;
  /** First line of the underlying error, so evidence can quote what the chain said. */
  message?: string;
}

/**
 * Custom errors the account raises when it refuses a call.
 *
 * A fixed list rather than text parsing, so an unrelated message that happens
 * to contain one of these words cannot be read as a policy rejection.
 */
export const ACCOUNT_REJECTIONS = [
  "ExceededSpendLimit",
  "NoSpendPermissions",
  "UnauthorizedCall",
  "KeyDoesNotExist",
  "CannotSelfExecute",
] as const;

export type AccountRejection = (typeof ACCOUNT_REJECTIONS)[number];

export function rejectionNameFrom(error: unknown): AccountRejection | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return ACCOUNT_REJECTIONS.find((name) => message.includes(name));
}

/**
 * Narrow a name recovered from anywhere onto the fixed list.
 *
 * The decoded revert and the SDK's throw both hand back plain strings, and a
 * published disclosure may only name an error the account can actually raise.
 * Anything else is dropped rather than published under a plausible label.
 */
export function isAccountRejection(name: string | undefined): name is AccountRejection {
  return name !== undefined && (ACCOUNT_REJECTIONS as readonly string[]).includes(name);
}

export interface ExecuteFn {
  (): Promise<{ status: string; callsId?: string; transactionHash?: Hex }>;
}

/**
 * Run an execution and classify what happened.
 *
 * `expect` states what the caller believes should happen, and it only affects
 * classification of a mined call. A throw is classified from the error itself:
 * a known account rejection is `EXPECTED_REJECTION` whatever the caller
 * expected, and anything else is `UNEXPECTED_FAILURE`. An RPC outage can
 * therefore never be recorded as a proven boundary.
 */
export async function executeExpectingOutcome(
  expect: "SUCCESS" | "REJECTION",
  execute: ExecuteFn,
): Promise<ExecutionResult> {
  try {
    const result = await execute();
    const confirmed = result.status === "CONFIRMED";
    const base = {
      status: result.status,
      ...(result.callsId === undefined ? {} : { callsId: result.callsId }),
      ...(result.transactionHash === undefined ? {} : { transactionHash: result.transactionHash }),
    };

    if (expect === "SUCCESS") {
      return { outcome: confirmed ? "SUCCESS" : "UNEXPECTED_FAILURE", ...base };
    }
    // A call that was supposed to be refused and instead confirmed is the one
    // result that falsifies the product's claim, so it is never "expected".
    return { outcome: confirmed ? "SUCCESS" : "EXPECTED_REJECTION", ...base };
  } catch (error) {
    const rejectionName = rejectionNameFrom(error);
    const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

    if (rejectionName === undefined) {
      return { outcome: "UNEXPECTED_FAILURE", status: "ERROR", message };
    }
    return { outcome: "EXPECTED_REJECTION", status: "REVERTED", rejectionName, message };
  }
}

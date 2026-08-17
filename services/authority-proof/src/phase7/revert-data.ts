/**
 * Getting the revert bytes back out of a failed relayed transaction.
 *
 * The SDK returns `{ status: "FAILED" }` and nothing else. The bytes exist —
 * they were produced inside the account contract — but nothing on the happy path
 * carries them back, so they have to be recovered from the chain.
 *
 * Two routes, tried in order, because neither is guaranteed:
 *
 *  1. Replay the exact transaction with `eth_call` one block earlier. The state
 *     is the state the transaction saw, so the call reverts the same way, and
 *     viem surfaces the raw data. This is the direct route and it works whenever
 *     the outermost frame bubbles the inner error.
 *  2. Look for the selector in the receipt's logs. An orchestrator that catches a
 *     failing call and emits it rather than bubbling it leaves the bytes there,
 *     and a four-byte needle in a log is weak evidence on its own but useful
 *     beside the account-state attribution.
 *
 * Returning `undefined` is a real answer. A step that cannot obtain revert bytes
 * must not pass on an assumption about what they would have said.
 */
import { slice } from "viem";
import type { Hex, PublicClient } from "viem";
import { REVERT_SELECTORS } from "@mandate/altana";

/**
 * Pull raw revert data out of whatever viem threw.
 *
 * Written against the shape rather than against the error classes: the relevant
 * error is nested at an unpredictable depth and every viem release has moved it
 * at least once. Reading `data` off any level that has one is stable in a way
 * that `instanceof` has not been.
 */
export function extractRevertData(error: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);

    const record = node as Record<string, unknown>;
    const data = record["data"];
    if (typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data) && data.length >= 10) {
      return data.toLowerCase() as Hex;
    }
    if (typeof data === "object" && data !== null) queue.push(data);

    for (const key of ["cause", "error", "walk", "details"]) {
      const nested = record[key];
      if (typeof nested === "object" && nested !== null) queue.push(nested);
    }
  }

  return undefined;
}

/** Selectors this proof knows how to name, as a needle set for the log scan. */
const KNOWN_SELECTORS = Object.keys(REVERT_SELECTORS).map((selector) => selector.slice(2));

function selectorInLogs(logs: readonly { data: Hex }[]): Hex | undefined {
  for (const log of logs) {
    const body = log.data.slice(2).toLowerCase();
    for (const selector of KNOWN_SELECTORS) {
      const at = body.indexOf(selector);
      // Selectors are word-aligned when a contract stores revert bytes, so an
      // odd offset is a coincidental byte match rather than an error payload.
      if (at >= 0 && at % 2 === 0) return `0x${selector}`;
    }
  }
  return undefined;
}

export interface RecoveredRevert {
  data?: Hex;
  /** How the bytes were obtained, so evidence can say how strong they are. */
  source: "ETH_CALL_REPLAY" | "RECEIPT_LOG_SCAN" | "NONE";
  /** Present when the transaction did not revert at all. */
  succeeded?: boolean;
}

export async function recoverRevertData(
  client: PublicClient,
  txHash: Hex,
): Promise<RecoveredRevert> {
  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => undefined);
  if (receipt === undefined) return { source: "NONE" };
  if (receipt.status === "success") return { source: "NONE", succeeded: true };

  const transaction = await client.getTransaction({ hash: txHash }).catch(() => undefined);
  if (transaction !== undefined && transaction.to !== null) {
    try {
      await client.call({
        account: transaction.from,
        to: transaction.to,
        data: transaction.input,
        value: transaction.value,
        blockNumber: receipt.blockNumber - 1n,
      });
    } catch (error) {
      const data = extractRevertData(error);
      if (data !== undefined) return { data, source: "ETH_CALL_REPLAY" };
    }
  }

  const fromLogs = selectorInLogs(receipt.logs);
  if (fromLogs !== undefined) return { data: fromLogs, source: "RECEIPT_LOG_SCAN" };

  return { source: "NONE" };
}

/** First four bytes, for recording alongside a decoded revert. */
export function selectorOfRevert(data: Hex | undefined): Hex | undefined {
  return data === undefined || data.length < 10 ? undefined : (slice(data, 0, 4).toLowerCase() as Hex);
}

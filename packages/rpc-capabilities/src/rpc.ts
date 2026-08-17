/**
 * The thinnest JSON-RPC client that can tell three answers apart.
 *
 * A probe needs more than "did it throw". Three outcomes look identical to a
 * try/catch and mean completely different things:
 *
 *   the endpoint answered, and the answer is real state          → capable
 *   the endpoint answered, and the answer is "that state is gone" → not capable
 *   the socket dropped, or a rate limiter said no                 → no measurement
 *
 * Collapsing the third into the second is how a busy free endpoint gets
 * recorded as having a shallow retention window, and that record then refuses
 * scenarios the provider would have served perfectly well. So transport
 * failures are their own outcome and the search retries them instead of
 * believing them.
 *
 * No viem here on purpose. This package has no runtime dependencies: it is the
 * thing you run to find out whether the rest of the stack can run at all, and
 * it reads one 32-byte word from one contract to do it.
 */

/** `totalSupply()`. Four bytes, one storage slot, present on every BEP-20. */
export const TOTAL_SUPPLY_SELECTOR = "0x18160ddd" as const;

export type RpcOutcome<T> =
  | { readonly kind: "OK"; readonly value: T }
  /** The node answered and said the state is not there. A real measurement. */
  | { readonly kind: "STATE_UNAVAILABLE"; readonly message: string }
  /** Nothing was learned. Retry before believing anything. */
  | { readonly kind: "TRANSPORT"; readonly message: string };

/**
 * Node phrasings for "I no longer hold that state".
 *
 * Deliberately a list of substrings rather than a parsed error code: BSC nodes
 * are erigon, geth and reth forks with three different vocabularies for the
 * same condition, and none of them agree on a JSON-RPC error code either.
 */
const PRUNED_SIGNATURES = [
  "missing trie node",
  "is pruned",
  "historical state",
  "state at block",
  "header not found",
  "block not found",
  "not available",
  "unavailable",
  "no historical",
  "required historical state unavailable",
  "state is not available",
];

/**
 * Phrasings that say nothing about the state.
 *
 * Rate limits belong here, not in the list above. `publicnode` throttles under
 * a bisection's burst, and a throttled probe recorded as pruned state is a
 * measurement of our own request rate rather than of the provider.
 */
const TRANSPORT_SIGNATURES = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "socket hang up",
  "fetch failed",
  "terminated",
  "timeout",
  "timed out",
  "aborted",
  "too many requests",
  "rate limit",
  "limit exceeded",
  "capacity",
  "try again",
  "service unavailable",
  "bad gateway",
  "internal error",
];

/**
 * Turn an error message into "the node answered no" or "the node did not answer".
 *
 * Unrecognised messages fall through to `STATE_UNAVAILABLE`, which is the
 * conservative direction: it records a narrower window than the provider might
 * have, where the opposite mistake queues trials against state that is not
 * there. It also covers the case the signature lists cannot anticipate —
 * `bsc-rpc.publicnode.com` now answers every historical call with "Archive
 * requests require a personal token", which is neither pruning nor transport
 * and is nonetheless a definitive no.
 */
export function classifyRpcFailure(message: string): "STATE_UNAVAILABLE" | "TRANSPORT" {
  const lowered = message.toLowerCase();
  // Transport wins ties. A throttle message that happens to contain the word
  // "unavailable" is still a throttle, and mislabelling it shrinks the recorded
  // window on a provider that was fine.
  if (TRANSPORT_SIGNATURES.some((signature) => lowered.includes(signature))) return "TRANSPORT";
  if (PRUNED_SIGNATURES.some((signature) => lowered.includes(signature))) return "STATE_UNAVAILABLE";
  return "STATE_UNAVAILABLE";
}

export interface RpcCallOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export async function jsonRpc<T>(
  endpoint: string,
  method: string,
  params: readonly unknown[],
  options: RpcCallOptions = {},
): Promise<RpcOutcome<T>> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      // An HTTP-level refusal is the endpoint declining to talk, never a
      // statement about a block. 429 and 5xx both land here.
      return { kind: "TRANSPORT", message: `HTTP ${response.status} ${response.statusText}` };
    }

    const body = (await response.json()) as {
      result?: T;
      error?: { code?: number; message?: string };
    };

    if (body.error !== undefined) {
      const message = body.error.message ?? `error code ${body.error.code ?? "unknown"}`;
      return { kind: classifyRpcFailure(message), message };
    }
    if (body.result === undefined) {
      return { kind: "TRANSPORT", message: `${method} returned neither a result nor an error` };
    }
    return { kind: "OK", value: body.result };
  } catch (error) {
    return { kind: "TRANSPORT", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function latestBlockNumber(
  endpoint: string,
  options: RpcCallOptions = {},
): Promise<bigint> {
  const outcome = await jsonRpc<string>(endpoint, "eth_blockNumber", [], options);
  if (outcome.kind !== "OK") {
    throw new Error(`could not read the head from ${endpoint}: ${outcome.message}`);
  }
  return BigInt(outcome.value);
}

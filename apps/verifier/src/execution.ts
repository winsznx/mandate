/**
 * Checking the two transactions that carry the headline claim.
 *
 * One action inside the granted authority succeeded. One action outside it was
 * refused. Both are read back from chain, because a disclosure that merely
 * asserts them proves nothing.
 *
 * The refusal is the harder of the two and the one worth getting right. A
 * transaction that reverted is not evidence of bounded authority — it is
 * evidence that something went wrong, and "the spend cap stopped it" and "the
 * standing ERC-20 allowance was too small" are the same status code with
 * completely different meanings. Only a revert that decodes to an enforcement
 * layer rejection counts here. Everything else is reported as what it is: a
 * fault, or an unattributable failure.
 */
import { decodeRevert, isPolicyRejection } from "@mandate/altana";
import type { DecodedRevert } from "@mandate/altana";
import { BaseError, RawContractError } from "viem";
import type { Address, Hex, PublicClient } from "viem";

export type ExecutionStatus = "CONFIRMED" | "REJECTED" | "NOT_FOUND" | "UNATTRIBUTABLE";

export interface ExecutionFinding {
  txHash: Hex;
  label: string;
  status: ExecutionStatus;
  /** What the chain says happened, phrased for the report. */
  summary: string;
  from?: Address;
  to?: Address;
  blockNumber?: bigint;
  revert?: DecodedRevert;
  /** True when the transaction demonstrably involved the mandate's wallet or a granted target. */
  linkedToMandate?: boolean;
}

export interface ExecutionContext {
  wallet: Address;
  /** Call targets in the granted authority. Empty when the grant was not disclosed. */
  grantedTargets: ReadonlySet<Address>;
}

function lower(value: string | null | undefined): Address | undefined {
  return value === null || value === undefined ? undefined : (value.toLowerCase() as Address);
}

/**
 * Does this transaction have anything to do with the mandate?
 *
 * Checked because a disclosure could otherwise point at any successful
 * transaction on the chain. Under EIP-7702 the wallet is an EOA delegating to
 * an account implementation, and a relayed session call arrives from an
 * orchestrator rather than from the wallet, so sender and recipient alone are
 * not enough — a log emitted by the wallet or by a granted target is the link
 * that survives relaying.
 */
function isLinked(
  context: ExecutionContext,
  parts: { from?: Address; to?: Address; logAddresses: readonly Address[] },
): boolean {
  if (parts.from === context.wallet || parts.to === context.wallet) return true;
  if (parts.logAddresses.includes(context.wallet)) return true;
  return parts.logAddresses.some((address) => context.grantedTargets.has(address));
}

const HEX_DATA = /^0x[0-9a-fA-F]*$/;

/**
 * Dig raw revert data out of whatever the RPC threw.
 *
 * viem surfaces the payload in two different places depending on how the call
 * was made. With an ABI it wraps it in a `RawContractError`; on a bare
 * `eth_call` it never constructs one, and the bytes sit on the underlying
 * `RpcRequestError` several `cause` levels down. Only checking the first place
 * silently loses every revert reason on the path that matters here, so both are
 * walked.
 */
function extractRevertData(error: unknown): Hex | undefined {
  if (error instanceof BaseError) {
    const raw = error.walk((candidate) => candidate instanceof RawContractError);
    if (raw instanceof RawContractError) {
      const data = raw.data;
      if (typeof data === "string" && HEX_DATA.test(data)) return data as Hex;
      if (data !== undefined && typeof data === "object" && typeof data.data === "string") {
        return data.data as Hex;
      }
    }
  }

  let node: unknown = error;
  for (let depth = 0; depth < 8 && node !== undefined && node !== null; depth += 1) {
    const candidate = (node as { data?: unknown }).data;
    if (typeof candidate === "string" && HEX_DATA.test(candidate) && candidate.length > 2) {
      return candidate as Hex;
    }
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Replay a failed transaction to recover why it failed.
 *
 * `eth_call` against the parent block is the only portable way to get a reason:
 * a mined receipt carries a status and no revert data, and
 * `debug_traceTransaction` is not available on any free BSC endpoint.
 */
async function replayForRevertData(
  client: PublicClient,
  params: { from: Address; to: Address | undefined; data: Hex; value: bigint; blockNumber: bigint },
): Promise<Hex | undefined> {
  if (params.to === undefined) return undefined;
  if (params.blockNumber === 0n) return undefined;

  try {
    await client.call({
      account: params.from,
      to: params.to,
      data: params.data,
      value: params.value,
      blockNumber: params.blockNumber - 1n,
    });
    // The replay succeeded, so the revert depended on state the parent block
    // does not have. Nothing can be attributed from here.
    return undefined;
  } catch (error) {
    return extractRevertData(error);
  }
}

/** Confirm a transaction that is claimed to be inside the granted authority. */
export async function checkAllowedExecution(
  client: PublicClient,
  context: ExecutionContext,
  disclosed: { txHash: Hex; label: string },
): Promise<ExecutionFinding> {
  const found = await loadTransaction(client, disclosed.txHash);
  if (found === undefined) {
    return {
      txHash: disclosed.txHash,
      label: disclosed.label,
      status: "NOT_FOUND",
      summary: "no such transaction on this chain",
    };
  }

  const { transaction, receipt } = found;
  const from = lower(transaction.from);
  const to = lower(transaction.to);
  const logAddresses = receipt.logs.map((log) => log.address.toLowerCase() as Address);
  const linked = isLinked(context, {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    logAddresses,
  });

  if (receipt.status !== "success") {
    return {
      txHash: disclosed.txHash,
      label: disclosed.label,
      status: "REJECTED",
      summary: "the transaction reverted, so it does not demonstrate a permitted action",
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      blockNumber: receipt.blockNumber,
      linkedToMandate: linked,
    };
  }

  return {
    txHash: disclosed.txHash,
    label: disclosed.label,
    status: "CONFIRMED",
    summary: linked
      ? "confirmed on chain and linked to this mandate's wallet or a granted target"
      : "confirmed on chain, but nothing ties it to this mandate's wallet or to a granted call target",
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    blockNumber: receipt.blockNumber,
    linkedToMandate: linked,
  };
}

/** Confirm that a transaction was refused BY THE ENFORCEMENT LAYER, not by anything else. */
export async function checkBlockedExecution(
  client: PublicClient,
  context: ExecutionContext,
  disclosed: { txHash: Hex; label: string },
): Promise<ExecutionFinding> {
  const found = await loadTransaction(client, disclosed.txHash);
  if (found === undefined) {
    return {
      txHash: disclosed.txHash,
      label: disclosed.label,
      status: "NOT_FOUND",
      summary: "no such transaction on this chain",
    };
  }

  const { transaction, receipt } = found;
  const from = lower(transaction.from);
  const to = lower(transaction.to);
  const logAddresses = receipt.logs.map((log) => log.address.toLowerCase() as Address);
  const linked = isLinked(context, {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    logAddresses,
  });
  const base = {
    txHash: disclosed.txHash,
    label: disclosed.label,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    blockNumber: receipt.blockNumber,
    linkedToMandate: linked,
  };

  if (receipt.status === "success") {
    return {
      ...base,
      status: "CONFIRMED",
      summary: "the transaction SUCCEEDED, so it is not evidence that the boundary held",
    };
  }

  const data =
    from === undefined
      ? undefined
      : await replayForRevertData(client, {
          from,
          to,
          data: transaction.input,
          value: transaction.value,
          blockNumber: receipt.blockNumber,
        });

  if (data === undefined) {
    return {
      ...base,
      status: "UNATTRIBUTABLE",
      summary:
        "the transaction reverted but the node returned no revert data on replay, so the refusal cannot be attributed to the enforcement layer",
    };
  }

  const revert = decodeRevert(data);
  return {
    ...base,
    status: isPolicyRejection(revert) ? "REJECTED" : "UNATTRIBUTABLE",
    summary: isPolicyRejection(revert)
      ? `refused by the enforcement layer: ${revert.name ?? "policy"} — ${revert.reason}`
      : `reverted, but not by the enforcement layer (${revert.class}): ${revert.reason}`,
    revert,
  };
}

async function loadTransaction(client: PublicClient, txHash: Hex) {
  try {
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash }),
      client.getTransactionReceipt({ hash: txHash }),
    ]);
    return { transaction, receipt };
  } catch {
    return undefined;
  }
}

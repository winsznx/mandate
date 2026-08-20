/**
 * Putting a proposal on the fork, and recording what the fork did with it.
 *
 * Shared by both trial lifecycles. The health-factor run and the allocation and
 * trading runs disagree about what a correct answer looks like and about which
 * model predicts it; they agree completely about how a proposed call becomes a
 * transaction and how that transaction becomes evidence. Keeping one copy of
 * that is what stops the two lanes drifting into recording a revert, a gas
 * figure or a selector differently, which a reader comparing two artifacts
 * would have no way to attribute.
 *
 * Nothing here judges anything. It encodes what the agent described, submits
 * it, and reports the receipt.
 */
import { createPublicClient, defineChain, encodeAbiParameters, http } from "viem";
import type { AbiParameter, Address, Hex, PublicClient } from "viem";
import type { TransactionEvidence } from "@mandate/domain";
import type { Proposal } from "@mandate/agent-runtime";
import { forkRpc, type ForkHandle } from "./anvil.js";
import { TrialInfrastructureError } from "./errors.js";
import type { InvocationRecord } from "./invoke.js";
import type { SetupTransaction } from "./scenario.js";

const RECEIPT_POLL_ATTEMPTS = 40;
const RECEIPT_POLL_MS = 250;

export function forkClient(fork: ForkHandle, chainId: number): PublicClient {
  const chain = defineChain({
    id: chainId,
    name: "trial-fork",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [fork.endpoint] } },
  });
  return createPublicClient({ chain, transport: http(fork.endpoint) }) as PublicClient;
}

/**
 * Encode a proposed action into calldata.
 *
 * The argument types come from the proposal itself, which is why
 * `ProposedAction` carries them: the deterministic layer encodes what the agent
 * described rather than inferring types from a signature it guessed at.
 */
export function encodeAction(proposal: Extract<Proposal, { decision: "PROPOSE" }>): Hex {
  const parameters: AbiParameter[] = proposal.action.args.map((argument) => ({
    type: argument.type,
    name: "",
  }));

  const values = proposal.action.args.map((argument) => {
    if (argument.type.startsWith("uint") || argument.type.startsWith("int")) {
      return BigInt(argument.value);
    }
    if (argument.type === "bool") return argument.value === "true";
    if (argument.type === "address" || argument.type.startsWith("bytes")) {
      return argument.value as Hex;
    }
    if (argument.type === "string") return argument.value;
    throw new TrialInfrastructureError(
      "TRANSACTION_SUBMISSION_FAILED",
      `the proposal used an argument type the runner cannot encode: ${argument.type}`,
    );
  });

  const encoded = encodeAbiParameters(parameters, values);
  return `${proposal.action.selector}${encoded.slice(2)}` as Hex;
}

export function selectorOf(data: Hex): string | undefined {
  return data.length >= 10 ? data.slice(0, 10).toLowerCase() : undefined;
}

interface RawReceipt {
  readonly status: Hex;
  readonly gasUsed: Hex;
  readonly blockNumber: Hex;
}

/**
 * Wait for a receipt.
 *
 * Anvil automines, so the receipt is usually there on the first ask, but the
 * send and the lookup are two round trips and the mine lands between them. A
 * single unpolled read turns that race into `TRANSACTION_SUBMISSION_FAILED`,
 * which would abandon a trial over a few hundred milliseconds.
 */
export async function awaitReceipt(fork: ForkHandle, hash: Hex): Promise<RawReceipt> {
  for (let attempt = 0; attempt < RECEIPT_POLL_ATTEMPTS; attempt += 1) {
    const receipt = await forkRpc<RawReceipt | null>(fork, "eth_getTransactionReceipt", [hash]);
    if (receipt !== null) return receipt;
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }
  throw new TrialInfrastructureError(
    "TRANSACTION_SUBMISSION_FAILED",
    `the fork produced no receipt for ${hash}`,
  );
}

export async function toTransactionEvidence(
  fork: ForkHandle,
  hash: Hex,
  index: number,
  origin: "AGENT_PROPOSAL" | "SCENARIO_SETUP",
  request: { from: Address; to: Address; data: Hex; value: bigint },
): Promise<TransactionEvidence> {
  const receipt = await awaitReceipt(fork, hash);

  const succeeded = BigInt(receipt.status) === 1n;
  const selector = selectorOf(request.data);

  return {
    index,
    from: request.from.toLowerCase() as Address,
    to: request.to.toLowerCase() as Address,
    ...(selector === undefined ? {} : { selector }),
    value: request.value.toString(10),
    data: request.data.toLowerCase() as Hex,
    gasUsed: BigInt(receipt.gasUsed).toString(10),
    status: succeeded ? "SUCCESS" : "REVERTED",
    blockNumber: BigInt(receipt.blockNumber).toString(10),
    txHash: hash.toLowerCase() as Hex,
    origin,
  };
}

/**
 * Submit the agent's proposal.
 *
 * A revert is a result, not an infrastructure failure — an agent that proposes
 * a call the protocol rejects has told us something real — so the reverted
 * receipt is captured and handed to the evaluator rather than raised.
 */
export async function submitProposal(
  fork: ForkHandle,
  wallet: Address,
  proposal: Extract<Proposal, { decision: "PROPOSE" }>,
  index: number,
): Promise<TransactionEvidence> {
  const data = encodeAction(proposal);
  const request = { from: wallet, to: proposal.action.target, data, value: 0n };

  const hash = await forkRpc<Hex>(fork, "eth_sendTransaction", [
    { from: request.from, to: request.to, data: request.data, value: "0x0" },
  ]).catch((error: unknown) => {
    if (error instanceof TrialInfrastructureError && /revert/i.test(error.detail)) {
      return null;
    }
    throw error;
  });

  if (hash === null) {
    return {
      index,
      from: wallet.toLowerCase() as Address,
      to: proposal.action.target.toLowerCase() as Address,
      ...(selectorOf(data) === undefined ? {} : { selector: selectorOf(data) as string }),
      value: "0",
      data: data.toLowerCase() as Hex,
      gasUsed: "0",
      status: "REVERTED",
      revertReason: "the fork rejected the transaction before it was mined",
      blockNumber: fork.blockNumber.toString(10),
      txHash: `0x${"0".repeat(64)}` as Hex,
      origin: "AGENT_PROPOSAL",
    };
  }

  return toTransactionEvidence(fork, hash, index, "AGENT_PROPOSAL", request);
}

/** The block the agent says it reasoned about, when it publishes one. */
export function agentObservedBlock(invocation: InvocationRecord): string | null {
  const observations = invocation.proposal.observations;
  if (observations === null || typeof observations !== "object" || Array.isArray(observations)) {
    return null;
  }
  const block = (observations as Record<string, unknown>)["blockNumber"];
  return typeof block === "string" ? block : null;
}

export async function setupEvidence(
  fork: ForkHandle,
  setup: readonly SetupTransaction[],
): Promise<TransactionEvidence[]> {
  const records: TransactionEvidence[] = [];
  for (const [index, transaction] of setup.entries()) {
    records.push(
      await toTransactionEvidence(fork, transaction.hash, index, "SCENARIO_SETUP", {
        from: transaction.from,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
      }),
    );
  }
  return records;
}

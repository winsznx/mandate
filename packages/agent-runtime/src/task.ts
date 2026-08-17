/**
 * Task decode and encode for the A2A JSON-RPC face.
 *
 * The envelope is `message/send` with a single data part, byte-compatible with
 * the live capture in report 02 §4.3, so MANDATE's adapter reaches a reference
 * agent through exactly the code path it uses for a third-party one. What
 * differs is only the vocabulary inside the data part: upstream sells ERC-8183
 * jobs, a MANDATE reference agent deliberates over a position. That is why the
 * adapter reads `card.skills[].id` and never hardcodes a skill.
 *
 * Decoding returns a result rather than throwing, because the difference
 * between a malformed envelope and an unknown skill is a different JSON-RPC
 * code and a different HTTP status, and that decision belongs here rather than
 * in a catch block.
 */
import { isAddress, getAddress } from "viem";
import type { Address } from "viem";
import { JSON_RPC_CODE, jsonRpcError } from "./errors.js";
import type { JsonRpcCode, JsonRpcErrorResponse } from "./errors.js";
import type { Proposal, ProposalRequest } from "./executor.js";

export const A2A_METHOD = "message/send" as const;

export interface DecodedTask {
  readonly ok: true;
  readonly id: string | number | null;
  readonly request: ProposalRequest;
}

export interface DecodeFailure {
  readonly ok: false;
  readonly response: JsonRpcErrorResponse;
  readonly code: JsonRpcCode;
}

export type DecodeResult = DecodedTask | DecodeFailure;

interface DataPart {
  readonly kind: "data";
  readonly data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(id: string | number | null, code: JsonRpcCode, message: string): DecodeFailure {
  return { ok: false, code, response: jsonRpcError(id, code, message) };
}

/**
 * Decode one JSON-RPC envelope into a proposal request.
 *
 * `defaults.chainId` fills in for a caller that omits it, since every reference
 * agent is deployed against a single chain and the trial harness should not
 * have to restate it. A caller that does supply a mismatching chain is
 * rejected rather than silently redirected.
 */
export function decodeTaskRequest(
  body: unknown,
  defaults: { readonly chainId: number; readonly requestId: string },
): DecodeResult {
  if (!isRecord(body)) {
    return fail(null, JSON_RPC_CODE.INVALID_REQUEST, "request body must be a JSON object");
  }

  const rawId = body["id"];
  const id = typeof rawId === "string" || typeof rawId === "number" ? rawId : null;

  if (body["jsonrpc"] !== "2.0") {
    return fail(id, JSON_RPC_CODE.INVALID_REQUEST, "jsonrpc must be '2.0'");
  }
  if (body["method"] !== A2A_METHOD) {
    return fail(id, JSON_RPC_CODE.METHOD_NOT_FOUND, `Method not found: ${String(body["method"])}`);
  }

  const params = body["params"];
  if (!isRecord(params) || !isRecord(params["message"])) {
    return fail(id, JSON_RPC_CODE.INVALID_REQUEST, "params.message is required");
  }

  const parts = params["message"]["parts"];
  if (!Array.isArray(parts)) {
    return fail(id, JSON_RPC_CODE.INVALID_REQUEST, "params.message.parts must be an array");
  }

  const dataPart = parts.find(
    (part): part is DataPart => isRecord(part) && part["kind"] === "data" && isRecord(part["data"]),
  );
  if (dataPart === undefined) {
    return fail(
      id,
      JSON_RPC_CODE.INVALID_PARAMS,
      "message must carry a data part with a 'skill' field",
    );
  }

  const data = dataPart.data;
  const skill = data["skill"];
  if (typeof skill !== "string" || skill.length === 0) {
    return fail(
      id,
      JSON_RPC_CODE.INVALID_PARAMS,
      "message must carry a data part with a 'skill' field",
    );
  }

  const wallet = data["wallet"];
  if (typeof wallet !== "string" || !isAddress(wallet, { strict: false })) {
    return fail(id, JSON_RPC_CODE.INVALID_PARAMS, "'wallet' must be a 20-byte hex address");
  }

  const rawChainId = data["chainId"];
  if (rawChainId !== undefined && (typeof rawChainId !== "number" || !Number.isInteger(rawChainId))) {
    return fail(id, JSON_RPC_CODE.INVALID_PARAMS, "'chainId' must be an integer");
  }
  const chainId = rawChainId ?? defaults.chainId;
  if (chainId !== defaults.chainId) {
    return fail(
      id,
      JSON_RPC_CODE.INVALID_PARAMS,
      `this agent serves chain ${defaults.chainId}, not ${chainId}`,
    );
  }

  const rawParameters = data["parameters"];
  if (rawParameters !== undefined && !isRecord(rawParameters)) {
    return fail(id, JSON_RPC_CODE.INVALID_PARAMS, "'parameters' must be an object");
  }

  const messageId = params["message"]["messageId"];

  return {
    ok: true,
    id,
    request: {
      requestId: typeof messageId === "string" && messageId.length > 0 ? messageId : defaults.requestId,
      skill,
      chainId,
      wallet: getAddress(wallet).toLowerCase() as Address,
      parameters: rawParameters ?? {},
    },
  };
}

export interface ProposalEnvelope {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result: {
    readonly kind: "message";
    readonly role: "agent";
    readonly messageId: string;
    readonly parts: readonly [{ readonly kind: "data"; readonly data: Record<string, unknown> }];
  };
}

/**
 * Encode a proposal as an A2A message reply.
 *
 * A `HOLD` travels as a normal result carrying `decision`, not as an error.
 * The split is the wire-level form of "fault versus outcome" — an agent that
 * correctly declines to act has not failed.
 */
export function encodeProposalResult(
  id: string | number | null,
  request: ProposalRequest,
  proposal: Proposal,
  messageId: string,
): ProposalEnvelope {
  const common = {
    requestId: request.requestId,
    skill: request.skill,
    chainId: request.chainId,
    wallet: request.wallet,
    decision: proposal.decision,
    observations: proposal.observations,
  };

  const data: Record<string, unknown> =
    proposal.decision === "PROPOSE"
      ? { ...common, action: proposal.action, rationale: proposal.action.rationale }
      : { ...common, action: null, rationale: proposal.rationale };

  return {
    jsonrpc: "2.0",
    id,
    result: {
      kind: "message",
      role: "agent",
      messageId,
      parts: [{ kind: "data", data }],
    },
  };
}

/**
 * JSON-RPC codes, fixed to the taxonomy captured off a live BNBAgent server in
 * report 02 §4.4 so a MANDATE adapter meets the same codes from a reference
 * agent as it does from a third-party one.
 *
 * The one addition is `NOT_IMPLEMENTED`. Upstream has no code for "this skill
 * is declared but unwritten", and folding it into `INTERNAL_ERROR` would make
 * an honestly-scaffolded agent indistinguishable from a broken one in a trial
 * record.
 */
export const JSON_RPC_CODE = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  RATE_LIMITED: -32000,
  NOT_IMPLEMENTED: -32001,
} as const;

export type JsonRpcCode = (typeof JSON_RPC_CODE)[keyof typeof JSON_RPC_CODE];

/**
 * HTTP status for a given code.
 *
 * Everything is 200 except parse and envelope-shape failures, which the wire
 * capture in report 02 §4.4 returns as 400. Returning 500 for a business
 * outcome would make retry logic upstream do the wrong thing.
 */
export function httpStatusFor(code: JsonRpcCode): number {
  return code === JSON_RPC_CODE.PARSE_ERROR || code === JSON_RPC_CODE.INVALID_REQUEST ? 400 : 200;
}

export interface JsonRpcErrorBody {
  readonly code: JsonRpcCode;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: JsonRpcErrorBody;
}

export function jsonRpcError(
  id: string | number | null,
  code: JsonRpcCode,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

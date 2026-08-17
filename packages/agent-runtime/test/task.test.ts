import { describe, expect, it } from "vitest";
import { JSON_RPC_CODE, httpStatusFor } from "../src/errors.js";
import { decodeTaskRequest, encodeProposalResult } from "../src/task.js";
import type { Proposal } from "../src/executor.js";
import { TEST_TARGET, TEST_WALLET, messageSend } from "./fixtures.js";

const DEFAULTS = { chainId: 97, requestId: "fallback-request-id" } as const;

describe("decodeTaskRequest", () => {
  it("extracts the proposal request from a data part", () => {
    // #given a message/send envelope carrying a skill and a wallet
    const body = messageSend({
      skill: "restore-health-factor",
      wallet: TEST_WALLET,
      parameters: { note: "hello" },
    });

    // #when decoded
    const result = decodeTaskRequest(body, DEFAULTS);

    // #then the request carries the skill, wallet and the envelope's messageId
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.skill).toBe("restore-health-factor");
    expect(result.request.wallet).toBe(TEST_WALLET);
    expect(result.request.chainId).toBe(97);
    expect(result.request.requestId).toBe("11111111-2222-3333-4444-555555555555");
    expect(result.request.parameters).toEqual({ note: "hello" });
  });

  it("lowercases a checksummed wallet so it matches the canonical address form", () => {
    // #given a checksummed address
    const body = messageSend({
      skill: "restore-health-factor",
      wallet: "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A",
    });

    // #when decoded
    const result = decodeTaskRequest(body, DEFAULTS);

    // #then the wallet is normalised
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.wallet).toBe("0xb7526572ffe56ab9d7489838bf2e18e3323b441a");
  });

  it("rejects a message with no data part using the upstream wording", () => {
    // #given an envelope whose only part is text
    const body = {
      jsonrpc: "2.0",
      id: 10,
      method: "message/send",
      params: { message: { kind: "message", role: "user", parts: [{ kind: "text", text: "hi" }] } },
    };

    // #when decoded
    const result = decodeTaskRequest(body, DEFAULTS);

    // #then it fails with -32602 and the message a live BNBAgent server returns
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(JSON_RPC_CODE.INVALID_PARAMS);
    expect(result.response.error.message).toBe(
      "message must carry a data part with a 'skill' field",
    );
  });

  it("rejects an unsupported method with -32601", () => {
    // #given a tasks/get call, which this face does not implement
    const body = { jsonrpc: "2.0", id: 11, method: "tasks/get", params: {} };

    // #when decoded
    const result = decodeTaskRequest(body, DEFAULTS);

    // #then it is method-not-found
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(JSON_RPC_CODE.METHOD_NOT_FOUND);
    expect(result.response.error.message).toBe("Method not found: tasks/get");
  });

  it("refuses a chain the agent is not deployed against", () => {
    // #given a request naming mainnet against a testnet agent
    const body = messageSend({ skill: "restore-health-factor", wallet: TEST_WALLET, chainId: 56 });

    // #when decoded
    const result = decodeTaskRequest(body, DEFAULTS);

    // #then it is rejected rather than silently served from chain 97
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(JSON_RPC_CODE.INVALID_PARAMS);
    expect(result.response.error.message).toContain("this agent serves chain 97");
  });

  it("rejects a wallet that is not an address", () => {
    // #given a data part whose wallet is a name
    const body = messageSend({ skill: "restore-health-factor", wallet: "not-an-address" });

    // #when decoded
    // #then it fails on the wallet
    const result = decodeTaskRequest(body, DEFAULTS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.error.message).toContain("'wallet'");
  });

  it("returns 400 only for parse and envelope-shape failures", () => {
    // #given the code taxonomy from the live capture
    // #when mapped to HTTP
    // #then business-level errors stay on 200
    expect(httpStatusFor(JSON_RPC_CODE.PARSE_ERROR)).toBe(400);
    expect(httpStatusFor(JSON_RPC_CODE.INVALID_REQUEST)).toBe(400);
    expect(httpStatusFor(JSON_RPC_CODE.INVALID_PARAMS)).toBe(200);
    expect(httpStatusFor(JSON_RPC_CODE.NOT_IMPLEMENTED)).toBe(200);
  });
});

describe("encodeProposalResult", () => {
  const request = {
    requestId: "req-1",
    skill: "restore-health-factor",
    chainId: 97,
    wallet: TEST_WALLET,
    parameters: {},
  } as const;

  it("wraps a proposed action in a data part", () => {
    // #given a PROPOSE outcome
    const proposal: Proposal = {
      decision: "PROPOSE",
      action: {
        target: TEST_TARGET,
        selector: "0x0e752702",
        args: [{ type: "uint256", value: "1000000" }],
        rationale: "health factor below threshold",
      },
      observations: { healthFactor: "1.10" },
    };

    // #when encoded
    const envelope = encodeProposalResult(1, request, proposal, "msg-1");

    // #then the action travels intact in the single data part
    const data = envelope.result.parts[0].data;
    expect(envelope.result.role).toBe("agent");
    expect(data["decision"]).toBe("PROPOSE");
    expect(data["action"]).toEqual(proposal.action);
    expect(data["rationale"]).toBe("health factor below threshold");
  });

  it("returns a hold as a normal result, not an error", () => {
    // #given a HOLD outcome
    const proposal: Proposal = {
      decision: "HOLD",
      rationale: "health factor above threshold",
      observations: { healthFactor: "1.80" },
    };

    // #when encoded
    const envelope = encodeProposalResult(2, request, proposal, "msg-2");

    // #then there is no error member and the action is explicitly null
    expect(envelope).not.toHaveProperty("error");
    expect(envelope.result.parts[0].data["decision"]).toBe("HOLD");
    expect(envelope.result.parts[0].data["action"]).toBeNull();
  });
});

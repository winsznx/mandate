import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentServer } from "../src/server.js";
import type { AgentServer } from "../src/server.js";
import { JSON_RPC_CODE } from "../src/errors.js";
import { StrategyNotImplementedError, pendingStrategy } from "../src/executor.js";
import { TEST_CONFIG, TEST_WALLET, messageSend, stubExecutor } from "./fixtures.js";

let agent: AgentServer;
let base: string;

beforeAll(async () => {
  agent = createAgentServer({
    executor: stubExecutor(),
    config: TEST_CONFIG,
    strategyStatus: "IMPLEMENTED",
  });
  const port = await agent.listen();
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await agent.close();
});

async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("agent server routes", () => {
  it("serves the agent card at the well-known path", async () => {
    // #given a running agent
    // #when the card is fetched
    const response = await fetch(`${base}/.well-known/agent-card.json`);
    const card = (await response.json()) as Record<string, unknown>;

    // #then discovery succeeds
    expect(response.status).toBe(200);
    expect(card["protocolVersion"]).toBe("0.3.0");
    expect(card["name"]).toBe("Stub Agent");
  });

  it("answers the healthcheck the platform polls", async () => {
    // #given a running agent
    // #when /healthz is polled
    const response = await fetch(`${base}/healthz`);
    const body = (await response.json()) as Record<string, unknown>;

    // #then it reports ok, the agent slug and the chain it serves
    expect(response.status).toBe(200);
    expect(body["status"]).toBe("ok");
    expect(body["agent"]).toBe("stub-agent");
    expect(body["chainId"]).toBe(97);
  });

  it("serves /ping as a liveness alias", async () => {
    // #given AgentCore probes /ping rather than /healthz
    // #when /ping is polled
    // #then the same body is returned
    const response = await fetch(`${base}/ping`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>)["status"]).toBe("ok");
  });

  it("returns a proposal for a known skill", async () => {
    // #given a request naming the agent's only skill
    const { status, json } = await post(
      messageSend({ skill: "restore-health-factor", wallet: TEST_WALLET }),
    );

    // #then the reply is an agent message carrying the proposed action
    expect(status).toBe(200);
    const result = json["result"] as Record<string, unknown>;
    const parts = result["parts"] as Array<{ data: Record<string, unknown> }>;
    expect(result["role"]).toBe("agent");
    expect(parts[0]?.data["decision"]).toBe("PROPOSE");
    expect((parts[0]?.data["action"] as Record<string, unknown>)["selector"]).toBe("0x0e752702");
  });

  it("rejects an unknown skill with -32602", async () => {
    // #given a skill the card does not advertise
    const { status, json } = await post(messageSend({ skill: "does-not-exist", wallet: TEST_WALLET }));

    // #then the wording matches what a live BNBAgent server returns
    expect(status).toBe(200);
    expect((json["error"] as Record<string, unknown>)["code"]).toBe(JSON_RPC_CODE.INVALID_PARAMS);
    expect((json["error"] as Record<string, unknown>)["message"]).toBe("Unknown skill: 'does-not-exist'");
  });

  it("returns 400 with -32700 for malformed JSON", async () => {
    // #given a body that is not JSON
    const { status, json } = await post("{not json");

    // #then the transport-level failure is a 400
    expect(status).toBe(400);
    expect((json["error"] as Record<string, unknown>)["code"]).toBe(JSON_RPC_CODE.PARSE_ERROR);
  });

  it("404s an unrouted path", async () => {
    // #given a path the agent does not serve
    // #when fetched
    // #then it 404s rather than falling through to the RPC handler
    expect((await fetch(`${base}/a2a`)).status).toBe(404);
  });
});

describe("agent server fault handling", () => {
  it("maps an unwritten strategy to its own code, not to an internal error", async () => {
    // #given an agent whose strategy is scaffolded but not implemented
    const pending = createAgentServer({
      executor: pendingStrategy({
        slug: "grid-a",
        displayName: "Tight Grid",
        description: "Pending.",
        category: "GRID",
        skills: [{ id: "adjust-grid", name: "Adjust grid", description: "Pending.", tags: [] }],
        policy: {},
      }),
      config: TEST_CONFIG,
      strategyStatus: "PENDING",
    });
    const port = await pending.listen();

    // #when its skill is invoked
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messageSend({ skill: "adjust-grid", wallet: TEST_WALLET })),
    });
    const json = (await response.json()) as Record<string, unknown>;
    await pending.close();

    // #then a trial record can tell "not written" apart from "crashed"
    expect((json["error"] as Record<string, unknown>)["code"]).toBe(JSON_RPC_CODE.NOT_IMPLEMENTED);
  });

  it("maps a genuine strategy fault to -32603", async () => {
    // #given a strategy that throws
    const broken = createAgentServer({
      executor: stubExecutor({
        propose: () => Promise.reject(new Error("rpc unreachable")),
      }),
      config: TEST_CONFIG,
      strategyStatus: "IMPLEMENTED",
    });
    const port = await broken.listen();

    // #when invoked
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(messageSend({ skill: "restore-health-factor", wallet: TEST_WALLET })),
    });
    const json = (await response.json()) as Record<string, unknown>;
    await broken.close();

    // #then it is an internal fault
    expect((json["error"] as Record<string, unknown>)["code"]).toBe(JSON_RPC_CODE.INTERNAL_ERROR);
  });
});

describe("StrategyNotImplementedError", () => {
  it("names the agent and the skill it was asked for", () => {
    // #given a stub agent asked for its declared skill
    const error = new StrategyNotImplementedError("grid-a", "adjust-grid");

    // #then the message identifies both, so a log line is actionable on its own
    expect(error.message).toContain("grid-a");
    expect(error.message).toContain("adjust-grid");
  });
});

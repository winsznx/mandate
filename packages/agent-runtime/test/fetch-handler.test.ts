import { describe, expect, it } from "vitest";
import { createFetchHandler } from "../src/fetch-handler.js";
import { JSON_RPC_CODE } from "../src/errors.js";
import { pendingStrategy } from "../src/executor.js";
import { TEST_CONFIG, TEST_WALLET, messageSend, stubExecutor } from "./fixtures.js";

const handler = createFetchHandler({
  executor: stubExecutor(),
  config: TEST_CONFIG,
  strategyStatus: "IMPLEMENTED",
});

const ORIGIN = "https://agent.example";

function get(path: string): Promise<Response> {
  return handler(new Request(`${ORIGIN}${path}`));
}

function post(body: unknown): Promise<Response> {
  return handler(
    new Request(`${ORIGIN}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("fetch handler parity with the node:http server", () => {
  it("serves the agent card at the well-known path", async () => {
    const response = await get("/.well-known/agent-card.json");
    const card = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(card["protocolVersion"]).toBe("0.3.0");
    expect(card["name"]).toBe("Stub Agent");
    expect(card["url"]).toBe(TEST_CONFIG.publicUrl);
  });

  it("answers /healthz and /ping", async () => {
    for (const path of ["/healthz", "/ping"]) {
      const response = await get(path);
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(body["status"]).toBe("ok");
      expect(body["agent"]).toBe("stub-agent");
      expect(body["chainId"]).toBe(97);
    }
  });

  it("runs a deliberation and returns the proposal", async () => {
    const response = await post(messageSend({ skill: "restore-health-factor", wallet: TEST_WALLET }));
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body["jsonrpc"]).toBe("2.0");
    expect(body).toHaveProperty("result");
  });

  it("rejects an unknown skill with INVALID_PARAMS", async () => {
    const response = await post(messageSend({ skill: "does-not-exist", wallet: TEST_WALLET }));
    const body = (await response.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(JSON_RPC_CODE.INVALID_PARAMS);
  });

  it("maps a not-yet-written strategy to NOT_IMPLEMENTED, not a crash", async () => {
    const pending = createFetchHandler({
      executor: pendingStrategy({
        slug: "pending",
        displayName: "Pending",
        description: "",
        category: "YIELD",
        skills: [{ id: "do-it", name: "Do it", description: "", tags: [] }],
        policy: {},
      }),
      config: TEST_CONFIG,
      strategyStatus: "PENDING",
    });
    const response = await pending(
      new Request(`${ORIGIN}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(messageSend({ skill: "do-it", wallet: TEST_WALLET })),
      }),
    );
    const body = (await response.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(JSON_RPC_CODE.NOT_IMPLEMENTED);
  });

  it("404s an unknown route", async () => {
    const response = await get("/nope");
    expect(response.status).toBe(404);
  });
});

/**
 * The gateway's own routing, exercised directly.
 *
 * The handler is a plain `fetch(request, env)` function with no Workers-only
 * API in its routing layer (chain access happens inside each agent's executor,
 * which none of these routes invoke), so it runs under plain Vitest with no
 * workerd runtime required.
 */
import { describe, expect, it } from "vitest";
import worker from "../src/worker.js";

const ENV = { GATEWAY_ORIGIN: "https://mandate-agents.example.workers.dev", CHAIN_ID: "97" };

const EXPECTED_SLUGS = [
  "grid-a",
  "grid-b",
  "health-factor-a",
  "health-factor-b",
  "rebalancing-a",
  "rebalancing-b",
  "yield-a",
  "yield-b",
];

function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://mandate-agents.example.workers.dev${path}`), ENV);
}

describe("gateway routing", () => {
  it("answers / and /healthz with the full agent roster", async () => {
    for (const path of ["/", "/healthz"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; agents: string[] };
      expect(body.status).toBe("ok");
      expect(body.agents.sort()).toEqual([...EXPECTED_SLUGS].sort());
    }
  });

  it("serves every agent's card at /<slug>.json, ending in that agent's own slug", async () => {
    for (const slug of EXPECTED_SLUGS) {
      const response = await get(`/${slug}.json`);
      expect(response.status).toBe(200);
      const card = (await response.json()) as {
        name: string;
        url: string;
        "x-mandate": { category: string };
      };
      expect(card.name.length).toBeGreaterThan(0);
      expect(card.url).toBe(`https://mandate-agents.example.workers.dev/${slug}`);
      expect(card["x-mandate"].category).toMatch(/^(GRID|HEALTH_FACTOR|REBALANCING|YIELD)$/);
    }
  });

  it("404s an unknown slug's card rather than guessing", async () => {
    const response = await get("/not-a-real-agent.json");
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({ error: "no agent 'not-a-real-agent'" });
  });

  it("404s an unknown agent path, and lists the real roster instead of a blank page", async () => {
    const response = await get("/not-a-real-agent");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; agents: string[] };
    expect(body.error).toContain("not-a-real-agent");
    expect(body.agents.sort()).toEqual([...EXPECTED_SLUGS].sort());
  });

  it("re-roots a per-agent request so the shared router sees the path it expects", async () => {
    const response = await get("/yield-a/.well-known/agent-card.json");
    expect(response.status).toBe(200);
    const card = (await response.json()) as { url: string };
    expect(card.url).toBe("https://mandate-agents.example.workers.dev/yield-a");
  });
});

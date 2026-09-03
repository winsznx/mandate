/**
 * The Cloudflare Workers gateway for all eight reference agents.
 *
 * The reference agents are read-only JSON-RPC servers — they price chain state
 * and return a proposed action, holding no key and signing nothing — so they do
 * not need a container. One Worker serves all eight, path-routed by slug:
 *
 *   https://<gateway>/<slug>/.well-known/agent-card.json
 *   https://<gateway>/<slug>/healthz
 *   POST https://<gateway>/<slug>
 *
 * Each agent's `url` in its card is `https://<gateway>/<slug>`, so an A2A client
 * that reads the card finds the JSON-RPC endpoint where the card says it is.
 *
 * The executor for each slug is the identical one its `node:http` entry point
 * builds — imported from the agent's own `./executor` export, not re-declared.
 */
import { createFetchHandler, readRuntimeConfig } from "@mandate/agent-runtime";
import type { AgentExecutor, AgentRuntimeConfig, FetchHandler } from "@mandate/agent-runtime";
import { buildExecutor as gridA } from "@mandate/agent-grid-a/executor";
import { buildExecutor as gridB } from "@mandate/agent-grid-b/executor";
import { buildExecutor as healthFactorA } from "@mandate/agent-health-factor-a/executor";
import { buildExecutor as healthFactorB } from "@mandate/agent-health-factor-b/executor";
import { buildExecutor as rebalancingA } from "@mandate/agent-rebalancing-a/executor";
import { buildExecutor as rebalancingB } from "@mandate/agent-rebalancing-b/executor";
import { buildExecutor as yieldA } from "@mandate/agent-yield-a/executor";
import { buildExecutor as yieldB } from "@mandate/agent-yield-b/executor";

type Builder = (config: AgentRuntimeConfig) => AgentExecutor;

const BUILDERS: Readonly<Record<string, Builder>> = {
  "grid-a": gridA,
  "grid-b": gridB,
  "health-factor-a": healthFactorA,
  "health-factor-b": healthFactorB,
  "rebalancing-a": rebalancingA,
  "rebalancing-b": rebalancingB,
  "yield-a": yieldA,
  "yield-b": yieldB,
};

interface Env {
  /** Public origin the gateway is served from, e.g. https://mandate-agents.example.workers.dev */
  readonly GATEWAY_ORIGIN?: string;
  readonly RPC_URL?: string;
  readonly RPC_FALLBACK_URL?: string;
  readonly CHAIN_ID?: string;
}

/** One handler per slug, built lazily and kept for the life of the isolate. */
const handlers = new Map<string, FetchHandler>();

function handlerFor(slug: string, env: Env): FetchHandler | undefined {
  const cached = handlers.get(slug);
  if (cached !== undefined) return cached;

  const build = BUILDERS[slug];
  if (build === undefined) return undefined;

  const origin = env.GATEWAY_ORIGIN ?? "http://localhost:8787";
  const config = readRuntimeConfig({
    AGENT_PUBLIC_URL: `${origin.replace(/\/$/, "")}/${slug}`,
    RPC_URL: env.RPC_URL,
    RPC_FALLBACK_URL: env.RPC_FALLBACK_URL,
    CHAIN_ID: env.CHAIN_ID,
  });

  const handler = createFetchHandler({
    executor: build(config),
    config,
    strategyStatus: "IMPLEMENTED",
  });
  handlers.set(slug, handler);
  return handler;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.replace(/^\/+/, "").split("/");
    const slug = segments[0] ?? "";

    if (slug === "" || slug === "healthz") {
      return Response.json({
        status: "ok",
        service: "mandate-agent-gateway",
        agents: Object.keys(BUILDERS),
      });
    }

    const handler = handlerFor(slug, env);
    if (handler === undefined) {
      return Response.json({ error: `no agent '${slug}'`, agents: Object.keys(BUILDERS) }, { status: 404 });
    }

    // Re-root the request at the agent so the shared router sees the paths it
    // expects (`/`, `/.well-known/agent-card.json`, `/healthz`).
    const rest = `/${segments.slice(1).join("/")}`;
    const rerooted = new Request(new URL(`${rest}${url.search}`, url.origin), request);
    return handler(rerooted);
  },
};

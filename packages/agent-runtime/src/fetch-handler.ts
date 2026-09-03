/**
 * The `fetch` face for a reference agent — Cloudflare Workers.
 *
 * The reference agents are read-only JSON-RPC servers: they price chain state
 * over `viem` and return a proposed action. Nothing in that needs a container,
 * so on Workers they run as a plain `fetch` handler over the same
 * `createAgentRouter` the `node:http` server uses. `server.ts` stays the path
 * for local runs and the Docker image.
 */
import { createAgentRouter } from "./router.js";
import type { AgentRouterOptions } from "./router.js";

const MAX_BODY_BYTES = 256 * 1024;

export type FetchHandler = (request: Request) => Promise<Response>;

/**
 * Build a `fetch` handler for one agent.
 *
 * The router is created once and closed over: a Worker isolate handles many
 * requests, and rebuilding the card and the chain client on each one would be
 * waste with no upside.
 */
export function createFetchHandler(options: AgentRouterOptions): FetchHandler {
  const router = createAgentRouter(options);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const readBody = async (): Promise<string> => {
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      }
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) {
        throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      }
      return text;
    };

    let result: { status: number; body: unknown };
    try {
      result = await router.handle(request.method, `${url.pathname}${url.search}`, readBody);
    } catch (error: unknown) {
      result = {
        status: 500,
        body: { error: error instanceof Error ? error.message : "internal error" },
      };
    }

    return Response.json(result.body, { status: result.status });
  };
}

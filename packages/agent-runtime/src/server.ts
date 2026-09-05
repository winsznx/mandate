/**
 * The `node:http` face for a reference agent — local runs and the Docker image.
 *
 * All routing, the card, the error taxonomy and the healthcheck live in
 * `router.ts`, which Cloudflare Workers reuse through `fetch-handler.ts`. This
 * file is only the adapter: read the request off a Node stream with a bounded
 * reader, hand method/path/body to the router, write its answer back.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AgentCard } from "./agent-card.js";
import type { AgentExecutor } from "./executor.js";
import type { Logger } from "./logging.js";
import { readRuntimeConfig } from "./config.js";
import type { AgentRuntimeConfig } from "./config.js";
import { BodyTooLargeError, MAX_BODY_BYTES, createAgentRouter } from "./router.js";

export interface AgentServerOptions {
  readonly executor: AgentExecutor;
  readonly config: AgentRuntimeConfig;
  readonly strategyStatus: "IMPLEMENTED" | "PENDING";
  readonly logger?: Logger;
  readonly proposeTimeoutMs?: number;
  /** The ERC-8004 id this build is registered under, surfaced in the card. */
  readonly agentId?: string;
}

export interface AgentServer {
  readonly server: Server;
  readonly card: AgentCard;
  readonly config: AgentRuntimeConfig;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export type StartAgentOptions = Omit<AgentServerOptions, "config">;

export function createAgentServer(options: AgentServerOptions): AgentServer {
  const router = createAgentRouter(options);
  const { config } = options;

  const server = createServer((request, response) => {
    const readBody = (): Promise<string> => readNodeBody(request);
    void router
      .handle(request.method ?? "GET", request.url ?? "/", readBody)
      .then((result) => sendJson(response, result.status, result.body))
      .catch((error: unknown) => {
        sendJson(response, 500, { error: error instanceof Error ? error.message : "internal error" });
      });
  });

  return {
    server,
    card: router.card,
    config,
    listen() {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : config.port;
          resolve(port);
        });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

/**
 * When `MANDATE_EMIT_CARD` names a path, `startAgent` writes the card the agent
 * would serve to that path and returns without binding a port.
 *
 * The marketplace inventory is the card each agent serves, so the published
 * artifact has to come from the same construction path a running agent uses
 * rather than a hand-written copy that can drift from it. `AGENT_PUBLIC_URL`
 * sets the `url` the emitted card advertises.
 */
async function emitCard(card: AgentCard, target: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(card, null, 2)}\n`, "utf8");
}

/**
 * Boot an agent from the environment.
 *
 * `SIGTERM` is handled because that is how a container platform asks for a
 * shutdown, and a process that ignores it is killed mid-request instead.
 */
export async function startAgent(options: StartAgentOptions): Promise<AgentServer> {
  const config = readRuntimeConfig();
  const envAgentId = process.env["AGENT_ID"];
  const agent = createAgentServer({
    ...options,
    config,
    ...(options.agentId === undefined && envAgentId !== undefined && envAgentId !== ""
      ? { agentId: envAgentId }
      : {}),
  });

  const emitTarget = process.env["MANDATE_EMIT_CARD"];
  if (emitTarget !== undefined && emitTarget !== "") {
    await emitCard(agent.card, emitTarget);
    return agent;
  }

  await agent.listen();

  const shutdown = (): void => {
    void agent.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return agent;
}

function readNodeBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

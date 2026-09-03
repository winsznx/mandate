/**
 * The HTTP face every reference agent shares.
 *
 * One server, eight strategies. Copying a server into eight directories would
 * mean eight places for the card format, the error taxonomy and the healthcheck
 * to drift, and MANDATE's whole claim rests on the eight being comparable to
 * each other and to a third-party agent.
 *
 * Routes:
 *   GET  /.well-known/agent-card.json   discovery, per report 02 §4.2
 *   GET  /healthz                       platform healthcheck
 *   GET  /ping                          liveness alias, AgentCore's convention
 *   POST /                              JSON-RPC `message/send`
 *
 * JSON-RPC sits at the root rather than at `/a2a` because that is where the
 * Studio scaffold puts it, and because the card advertises `url` anyway — a
 * correct client reads the path from the card instead of assuming one.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { buildAgentCard } from "./agent-card.js";
import type { AgentCard } from "./agent-card.js";
import { JSON_RPC_CODE, httpStatusFor, jsonRpcError } from "./errors.js";
import { StrategyNotImplementedError } from "./executor.js";
import type { AgentExecutor } from "./executor.js";
import { createLogger } from "./logging.js";
import type { Logger } from "./logging.js";
import { decodeTaskRequest, encodeProposalResult } from "./task.js";
import { readRuntimeConfig } from "./config.js";
import type { AgentRuntimeConfig } from "./config.js";

/** A deliberation reads chain state and cannot be allowed to hold a connection open forever. */
export const DEFAULT_PROPOSE_TIMEOUT_MS = 60_000;

/** Bounded so a malformed or hostile body cannot be buffered without limit. */
const MAX_BODY_BYTES = 256 * 1024;

export interface AgentServerOptions {
  readonly executor: AgentExecutor;
  readonly config: AgentRuntimeConfig;
  readonly strategyStatus: "IMPLEMENTED" | "PENDING";
  readonly logger?: Logger;
  readonly proposeTimeoutMs?: number;
}

export interface AgentServer {
  readonly server: Server;
  readonly card: AgentCard;
  readonly config: AgentRuntimeConfig;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createAgentServer(options: AgentServerOptions): AgentServer {
  const { executor, config, strategyStatus } = options;
  const logger =
    options.logger ??
    createLogger({ level: config.logLevel, base: { agent: executor.slug, chainId: config.chainId } });
  const card = buildAgentCard({ executor, publicUrl: config.publicUrl, strategyStatus });
  const skillIds = new Set(executor.skills.map((skill) => skill.id));
  const proposeTimeoutMs = options.proposeTimeoutMs ?? DEFAULT_PROPOSE_TIMEOUT_MS;
  const startedAt = Date.now();

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      logger.error("request.unhandled", { error });
      sendJson(response, 500, { error: "internal error" });
    });
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "/").split("?")[0] ?? "/";

    if (request.method === "GET" && path === "/.well-known/agent-card.json") {
      sendJson(response, 200, card);
      return;
    }
    if (request.method === "GET" && (path === "/healthz" || path === "/ping")) {
      sendJson(response, 200, {
        status: "ok",
        agent: executor.slug,
        category: executor.category,
        strategyStatus,
        chainId: config.chainId,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }
    if (request.method === "POST" && path === "/") {
      await handleRpc(request, response);
      return;
    }
    sendJson(response, 404, { error: `no route for ${request.method ?? "?"} ${path}` });
  }

  async function handleRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch (error: unknown) {
      const message = error instanceof BodyTooLargeError ? error.message : "Parse error";
      const failure = jsonRpcError(null, JSON_RPC_CODE.PARSE_ERROR, message);
      sendJson(response, httpStatusFor(JSON_RPC_CODE.PARSE_ERROR), failure);
      return;
    }

    const decoded = decodeTaskRequest(body, { chainId: config.chainId, requestId: randomUUID() });
    if (!decoded.ok) {
      logger.warn("rpc.rejected", { code: decoded.code, message: decoded.response.error.message });
      sendJson(response, httpStatusFor(decoded.code), decoded.response);
      return;
    }

    const { id, request: proposalRequest } = decoded;
    if (!skillIds.has(proposalRequest.skill)) {
      const failure = jsonRpcError(
        id,
        JSON_RPC_CODE.INVALID_PARAMS,
        `Unknown skill: '${proposalRequest.skill}'`,
      );
      sendJson(response, httpStatusFor(JSON_RPC_CODE.INVALID_PARAMS), failure);
      return;
    }

    const requestLogger = logger.child({ requestId: proposalRequest.requestId });
    requestLogger.info("propose.start", {
      skill: proposalRequest.skill,
      wallet: proposalRequest.wallet,
    });

    try {
      const proposal = await withTimeout(executor.propose(proposalRequest), proposeTimeoutMs);
      requestLogger.info("propose.done", {
        decision: proposal.decision,
        ...(proposal.decision === "PROPOSE"
          ? { target: proposal.action.target, selector: proposal.action.selector }
          : {}),
      });
      sendJson(response, 200, encodeProposalResult(id, proposalRequest, proposal, randomUUID()));
    } catch (error: unknown) {
      const notImplemented = error instanceof StrategyNotImplementedError;
      const code = notImplemented ? JSON_RPC_CODE.NOT_IMPLEMENTED : JSON_RPC_CODE.INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : "internal error";
      requestLogger[notImplemented ? "warn" : "error"]("propose.failed", { code, error });
      sendJson(response, httpStatusFor(code), jsonRpcError(id, code, message));
    }
  }

  return {
    server,
    card,
    config,
    listen() {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : config.port;
          logger.info("server.listening", { host: config.host, port, url: card.url });
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

export interface StartAgentOptions {
  readonly executor: AgentExecutor;
  readonly strategyStatus: "IMPLEMENTED" | "PENDING";
}

/**
 * When `MANDATE_EMIT_CARD` names a path, `startAgent` writes the card the agent
 * would serve to that path and returns without binding a port.
 *
 * The marketplace inventory is the card each agent serves, so the published
 * artifact has to come from the same construction path a running agent uses
 * rather than a hand-written copy that can drift from it. `PUBLIC_URL` sets the
 * `url` the emitted card advertises.
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
  const agent = createAgentServer({ ...options, config });

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

class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

function readBody(request: IncomingMessage): Promise<string> {
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deliberation exceeded ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
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

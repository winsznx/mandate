/**
 * The runtime-agnostic core of every reference agent's HTTP face.
 *
 * One router, eight strategies, two runtimes. `server.ts` wraps this in a
 * `node:http` server for local runs and the Docker image; `fetch-handler.ts`
 * wraps it in a `fetch` handler for Cloudflare Workers. Both share this file so
 * the card format, the error taxonomy and the healthcheck cannot drift between
 * them, and MANDATE's whole claim rests on the eight agents being comparable to
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
import { buildAgentCard } from "./agent-card.js";
import type { AgentCard } from "./agent-card.js";
import { JSON_RPC_CODE, httpStatusFor, jsonRpcError } from "./errors.js";
import { StrategyNotImplementedError } from "./executor.js";
import type { AgentExecutor } from "./executor.js";
import { createLogger } from "./logging.js";
import type { Logger } from "./logging.js";
import { decodeTaskRequest, encodeProposalResult } from "./task.js";
import type { AgentRuntimeConfig } from "./config.js";

/** A deliberation reads chain state and cannot be allowed to hold a connection open forever. */
export const DEFAULT_PROPOSE_TIMEOUT_MS = 60_000;

/** Bounded so a malformed or hostile body cannot be buffered without limit. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface AgentRouterOptions {
  readonly executor: AgentExecutor;
  readonly config: AgentRuntimeConfig;
  readonly strategyStatus: "IMPLEMENTED" | "PENDING";
  readonly logger?: Logger;
  readonly proposeTimeoutMs?: number;
}

export interface RouterResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Raised by a body reader that hit {@link MAX_BODY_BYTES} before the end of the stream. */
export class BodyTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export interface AgentRouter {
  readonly card: AgentCard;
  readonly strategyStatus: "IMPLEMENTED" | "PENDING";
  readonly startedAt: number;
  /**
   * Handle one request. `readBody` is a thunk so each runtime supplies its own
   * bounded reader, and a GET never pays to read a body it will not use.
   */
  handle(method: string, path: string, readBody: () => Promise<string>): Promise<RouterResponse>;
}

/** Present on Node ≥ 19 and on Workers; avoids a `node:crypto` import the Worker bundle would carry. */
const RANDOM_UUID = (): string => crypto.randomUUID();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`deliberation exceeded ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function createAgentRouter(options: AgentRouterOptions): AgentRouter {
  const { executor, config, strategyStatus } = options;
  const logger =
    options.logger ??
    createLogger({ level: config.logLevel, base: { agent: executor.slug, chainId: config.chainId } });
  const card = buildAgentCard({ executor, publicUrl: config.publicUrl, strategyStatus });
  const skillIds = new Set(executor.skills.map((skill) => skill.id));
  const proposeTimeoutMs = options.proposeTimeoutMs ?? DEFAULT_PROPOSE_TIMEOUT_MS;
  const startedAt = Date.now();

  async function handleRpc(readBody: () => Promise<string>): Promise<RouterResponse> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody());
    } catch (error: unknown) {
      const message = error instanceof BodyTooLargeError ? error.message : "Parse error";
      return {
        status: httpStatusFor(JSON_RPC_CODE.PARSE_ERROR),
        body: jsonRpcError(null, JSON_RPC_CODE.PARSE_ERROR, message),
      };
    }

    const decoded = decodeTaskRequest(body, { chainId: config.chainId, requestId: RANDOM_UUID() });
    if (!decoded.ok) {
      logger.warn("rpc.rejected", { code: decoded.code, message: decoded.response.error.message });
      return { status: httpStatusFor(decoded.code), body: decoded.response };
    }

    const { id, request: proposalRequest } = decoded;
    if (!skillIds.has(proposalRequest.skill)) {
      return {
        status: httpStatusFor(JSON_RPC_CODE.INVALID_PARAMS),
        body: jsonRpcError(id, JSON_RPC_CODE.INVALID_PARAMS, `Unknown skill: '${proposalRequest.skill}'`),
      };
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
      return { status: 200, body: encodeProposalResult(id, proposalRequest, proposal, RANDOM_UUID()) };
    } catch (error: unknown) {
      const notImplemented = error instanceof StrategyNotImplementedError;
      const code = notImplemented ? JSON_RPC_CODE.NOT_IMPLEMENTED : JSON_RPC_CODE.INTERNAL_ERROR;
      const message = error instanceof Error ? error.message : "internal error";
      requestLogger[notImplemented ? "warn" : "error"]("propose.failed", { code, error });
      return { status: httpStatusFor(code), body: jsonRpcError(id, code, message) };
    }
  }

  return {
    card,
    strategyStatus,
    startedAt,
    async handle(method, path, readBody) {
      const route = path.split("?")[0] ?? "/";

      if (method === "GET" && route === "/.well-known/agent-card.json") {
        return { status: 200, body: card };
      }
      if (method === "GET" && (route === "/healthz" || route === "/ping")) {
        return {
          status: 200,
          body: {
            status: "ok",
            agent: executor.slug,
            category: executor.category,
            strategyStatus,
            chainId: config.chainId,
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          },
        };
      }
      if (method === "POST" && route === "/") {
        return handleRpc(readBody);
      }
      return { status: 404, body: { error: `no route for ${method} ${route}` } };
    },
  };
}

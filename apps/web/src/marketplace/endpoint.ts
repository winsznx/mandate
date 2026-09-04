/**
 * Asking an agent's declared endpoint whether anything is behind it.
 *
 * A card can declare any URL. Whether that URL answers is the difference
 * between an agent that can be hired and a registration that cannot, so the
 * marketplace checks rather than assumes, and it checks at request time rather
 * than baking a verdict into a build that may be weeks old.
 *
 * The probe is a plain GET for the A2A agent card at its well-known path. It
 * sends no credential, follows the protocol's own discovery convention, and
 * treats anything short of a well-formed card as "did not answer" — with the
 * specific outcome recorded, because a 401 and a dead host are different
 * problems with different fixes for the developer who has to act on them.
 */
import { cache } from "react";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const PROBE_TIMEOUT_MS = 5_000;

/**
 * The reference-agent gateway. Requests to it are routed through the `AGENTS`
 * service binding: a Worker cannot reach another Worker on the same account
 * through its workers.dev hostname (Cloudflare error 1042), so a plain `fetch`
 * to this origin fails from the deployed site while succeeding everywhere else.
 */
const AGENT_GATEWAY_HOST = "mandate-agents.timjosh507.workers.dev";

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** `fetch`, but through the service binding when the target is the agent gateway. */
function fetcherFor(targetUrl: URL): Fetcher {
  if (targetUrl.host !== AGENT_GATEWAY_HOST) return { fetch: (i, n) => fetch(i, n) };
  try {
    const binding = (getCloudflareContext().env as Record<string, unknown>)["AGENTS"];
    if (binding !== undefined && binding !== null && typeof (binding as Fetcher).fetch === "function") {
      return binding as Fetcher;
    }
  } catch {
    // Outside the Workers runtime (local dev, tests): fall back to plain fetch.
  }
  return { fetch: (i, n) => fetch(i, n) };
}
/*
 * Resolved relative to the card's `url`, not the origin. An agent served at
 * `https://host/yield-a` has its card at `https://host/yield-a/.well-known/...`,
 * so a leading slash here would drop the path segment and probe the wrong place.
 */
const WELL_KNOWN_PATH = ".well-known/agent-card.json";

export type EndpointOutcome =
  | "ANSWERED"
  | "NOT_A_CARD"
  | "REQUIRES_AUTH"
  | "REFUSED"
  | "TIMED_OUT"
  | "UNREACHABLE"
  | "NOT_DECLARED"
  | "NOT_HTTP";

export interface EndpointProbe {
  outcome: EndpointOutcome;
  /** The exact URL that was requested, so the check can be repeated by hand. */
  probed: string | undefined;
  status: number | undefined;
  /** One sentence a developer can act on. */
  detail: string;
  observedAt: number;
}

export function endpointAnswered(probe: EndpointProbe): boolean {
  return probe.outcome === "ANSWERED";
}

export function endpointRequiresAuth(probe: EndpointProbe): boolean {
  return probe.outcome === "REQUIRES_AUTH";
}

export const probeEndpoint = cache(async (url: string | undefined): Promise<EndpointProbe> => {
  const observedAt = Math.floor(Date.now() / 1000);

  if (url === undefined || url.length === 0) {
    return {
      outcome: "NOT_DECLARED",
      probed: undefined,
      status: undefined,
      detail: "The card declares no endpoint, so there is nothing to call.",
      observedAt,
    };
  }

  let target: URL;
  try {
    target = new URL(WELL_KNOWN_PATH, url.endsWith("/") ? url : `${url}/`);
  } catch {
    return {
      outcome: "NOT_HTTP",
      probed: url,
      status: undefined,
      detail: `The declared endpoint ${url} is not a URL this page can request.`,
      observedAt,
    };
  }

  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return {
      outcome: "NOT_HTTP",
      probed: url,
      status: undefined,
      detail: `The declared endpoint uses ${target.protocol.replace(":", "")}, which is not a transport this page can call. Nothing is asserted about whether the agent runs.`,
      observedAt,
    };
  }

  const probed = target.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetcherFor(target).fetch(probed, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    if (response.status === 401 || response.status === 403) {
      return {
        outcome: "REQUIRES_AUTH",
        probed,
        status: response.status,
        detail: `The endpoint answered ${response.status}. It is running but will not describe itself without a credential, so this page cannot confirm what it does.`,
        observedAt,
      };
    }

    if (!response.ok) {
      return {
        outcome: "REFUSED",
        probed,
        status: response.status,
        detail: `The endpoint answered ${response.status} at its well-known agent-card path, so no agent is being served there.`,
        observedAt,
      };
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (!isAgentCard(body)) {
      return {
        outcome: "NOT_A_CARD",
        probed,
        status: response.status,
        detail:
          "Something answered, but it did not return an agent card. Answering is not the same as being callable.",
        observedAt,
      };
    }

    return {
      outcome: "ANSWERED",
      probed,
      status: response.status,
      detail: `The endpoint served an agent card naming "${body.name}".`,
      observedAt,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        outcome: "TIMED_OUT",
        probed,
        status: undefined,
        detail: `The endpoint did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds.`,
        observedAt,
      };
    }
    return {
      outcome: "UNREACHABLE",
      probed,
      status: undefined,
      detail: `The endpoint could not be reached: ${describe(error)}.`,
      observedAt,
    };
  } finally {
    clearTimeout(timer);
  }
});

/* -------------------------------------------------------------------------- */
/*  Task-shape probe                                                          */
/* -------------------------------------------------------------------------- */

const TASK_PROBE_TIMEOUT_MS = 9_000;

/**
 * An address with real positions on BSC testnet, so a health-factor or
 * rebalancing agent has something to reason about. An agent that finds nothing
 * to do returns HOLD, which still proves it accepts the task shape.
 */
const PROBE_WALLET = "0xdc5071910e6ca6855d45f96ba28ee0a2e5629299";

export type TaskProbeOutcome = "ACCEPTED" | "REJECTED" | "UNREACHABLE" | "NO_SKILL" | "NOT_HTTP";

export interface TaskProbe {
  outcome: TaskProbeOutcome;
  /** PROPOSE or HOLD when the agent answered with one. */
  decision: string | undefined;
  detail: string;
  observedAt: number;
}

export function taskAccepted(probe: TaskProbe): boolean {
  return probe.outcome === "ACCEPTED";
}

/**
 * Hand the agent a real task in its own declared skill and see whether it
 * returns a well-formed deliberation.
 *
 * This is the direct evidence the qualification ladder asks for at
 * CATEGORY_COMPATIBLE: not that a trial has happened, but that the running
 * agent accepts the shape of task its category defines. A `PROPOSE` or a
 * `HOLD` both count — an agent that correctly declines to act has still
 * understood the task. A JSON-RPC error, a not-implemented, or a malformed
 * reply does not.
 */
export const probeCategoryTask = cache(
  async (url: string | undefined, skillId: string | undefined, chainId: number): Promise<TaskProbe> => {
    const observedAt = Math.floor(Date.now() / 1000);

    if (url === undefined || url.length === 0) {
      return { outcome: "NOT_HTTP", decision: undefined, detail: "The card declares no endpoint.", observedAt };
    }
    if (skillId === undefined) {
      return { outcome: "NO_SKILL", decision: undefined, detail: "The card declares no skill to invoke.", observedAt };
    }

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { outcome: "NOT_HTTP", decision: undefined, detail: `${url} is not a URL.`, observedAt };
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return { outcome: "NOT_HTTP", decision: undefined, detail: `${url} is not an HTTP endpoint.`, observedAt };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TASK_PROBE_TIMEOUT_MS);

    const envelope = {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          messageId: `mandate-task-probe-${observedAt}`,
          parts: [{ kind: "data", data: { skill: skillId, wallet: PROBE_WALLET, chainId } }],
        },
      },
    };

    try {
      const response = await fetcherFor(target).fetch(target.toString(), {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(envelope),
        cache: "no-store",
      });

      const body: unknown = await response.json().catch(() => undefined);

      if (!response.ok || !isRecord(body) || "error" in body) {
        const message = isRecord(body) && isRecord(body["error"]) ? String(body["error"]["message"]) : `HTTP ${response.status}`;
        return {
          outcome: "REJECTED",
          decision: undefined,
          detail: `The agent did not accept the task: ${message}.`,
          observedAt,
        };
      }

      const decision = readDecision(body);
      if (decision === "PROPOSE" || decision === "HOLD") {
        return {
          outcome: "ACCEPTED",
          decision,
          detail:
            decision === "PROPOSE"
              ? "The agent accepted the task and returned a proposed action."
              : "The agent accepted the task and, finding nothing to do, held.",
          observedAt,
        };
      }

      return {
        outcome: "REJECTED",
        decision: undefined,
        detail: "The agent answered, but not with a recognisable deliberation.",
        observedAt,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return {
        outcome: "UNREACHABLE",
        decision: undefined,
        detail: timedOut
          ? `The agent did not answer the task within ${TASK_PROBE_TIMEOUT_MS / 1000} seconds.`
          : `The task could not be delivered: ${describe(error)}.`,
        observedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDecision(body: Record<string, unknown>): string | undefined {
  const result = body["result"];
  if (!isRecord(result)) return undefined;
  const parts = result["parts"];
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (isRecord(part) && isRecord(part["data"]) && typeof part["data"]["decision"] === "string") {
      return part["data"]["decision"];
    }
  }
  return undefined;
}

function isAgentCard(value: unknown): value is { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name: unknown }).name === "string"
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error) return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}

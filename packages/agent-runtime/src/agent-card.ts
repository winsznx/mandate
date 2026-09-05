/**
 * The A2A agent card served at `/.well-known/agent-card.json`.
 *
 * The shape follows the card captured off a live BNBAgent server in report 02
 * §4.2, because MANDATE's own adapter is card-driven and a reference agent that
 * needed special handling would not be testing the adapter it ships with.
 *
 * Two MANDATE-specific decisions are folded in:
 *
 *  - `version` stays `"1.0.0"`. Upstream hardcodes it in every template and
 *    never bumps it, so it carries no build identity. Emitting something that
 *    looked meaningful would invite a reader to trust it. `x-mandate` says
 *    plainly that it is not authoritative and points at `agentVersionHash`.
 *  - The risk policy is published in `x-mandate.policy`. A trial binds to the
 *    parameters that produced its result, and a policy the agent keeps to
 *    itself cannot be bound to.
 */
import { canonicalHash } from "@mandate/domain/canonical";
import type { AgentCategory, CanonicalValue } from "@mandate/domain";
import type { Hex } from "viem";
import type { AgentExecutor, AgentSkill } from "./executor.js";

/** A2A protocol version the captured cards advertise. Not the agent's version. */
export const A2A_PROTOCOL_VERSION = "0.3.0" as const;

/** Matches the upstream templates, which hardcode it. See the note above. */
export const SELF_REPORTED_VERSION = "1.0.0" as const;

export interface AgentCardSkill extends AgentSkill {
  readonly inputModes: readonly string[];
  readonly outputModes: readonly string[];
}

/**
 * MANDATE's card extension.
 *
 * Registry cards in the wild already carry vendor keys the spec never defined
 * (`active`, `x402Support`), so an extension block is the ordinary way to
 * publish this. It is namespaced so no reader mistakes it for A2A.
 */
export interface MandateCardExtension {
  readonly category: AgentCategory;
  /** Built from the BNB Agent Studio scaffold and self-hosted by the MANDATE team. */
  readonly scaffold: "bnb-agent-studio";
  readonly hosting: "self-hosted";
  readonly referenceAgent: true;
  /** The agent returns proposals; it holds no key and executes nothing. */
  readonly proposesOnly: true;
  readonly strategyStatus: "IMPLEMENTED" | "PENDING";
  readonly policy: CanonicalValue;
  readonly policyHash: Hex;
  /** `version` above is self-reported and unbumped upstream. Bind trials to `agentVersionHash`. */
  readonly versionIsAuthoritative: false;
  /**
   * The ERC-8004 agent id this build is registered under, when it is.
   *
   * A convenience for finding the registration, not a fact in itself: the
   * binding that counts is the on-chain registration pointing back at this
   * card. Excluded from `agentCardHash` for the same reason `url` is — the
   * identity an agent is minted under is not part of its behaviour.
   */
  readonly agentId?: string;
}

export interface AgentCard {
  readonly protocolVersion: typeof A2A_PROTOCOL_VERSION;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly preferredTransport: "JSONRPC";
  readonly version: typeof SELF_REPORTED_VERSION;
  readonly capabilities: { readonly streaming: false; readonly pushNotifications: false };
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly AgentCardSkill[];
  readonly "x-mandate": MandateCardExtension;
}

export interface BuildAgentCardOptions {
  readonly executor: AgentExecutor;
  /** Public base URL. JSON-RPC is served at the root, matching the Studio scaffold. */
  readonly publicUrl: string;
  readonly strategyStatus: "IMPLEMENTED" | "PENDING";
  /** The ERC-8004 id this build is registered under, when it is. */
  readonly agentId?: string | undefined;
}

export function buildAgentCard(options: BuildAgentCardOptions): AgentCard {
  const { executor, publicUrl, strategyStatus, agentId } = options;
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: executor.displayName,
    description: executor.description,
    url: normalizeBaseUrl(publicUrl),
    preferredTransport: "JSONRPC",
    version: SELF_REPORTED_VERSION,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: executor.skills.map((skill) => ({
      ...skill,
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    })),
    "x-mandate": {
      category: executor.category,
      scaffold: "bnb-agent-studio",
      hosting: "self-hosted",
      referenceAgent: true,
      proposesOnly: true,
      strategyStatus,
      policy: executor.policy,
      policyHash: canonicalHash(executor.policy),
      versionIsAuthoritative: false,
      ...(agentId === undefined || agentId === "" ? {} : { agentId }),
    },
  };
}

/**
 * `cardHash` as it enters the composite `agentVersionHash`.
 *
 * `url` and `x-mandate.agentId` are stripped because both move without the
 * agent's behaviour changing: `url` when it is redeployed behind a different
 * hostname, `agentId` when it is registered or re-registered on the identity
 * registry. Everything that describes behaviour — skills, descriptions,
 * capabilities, the published policy — stays in the preimage, so editing any of
 * them supersedes the trial that certified the previous build.
 */
export function agentCardHash(card: AgentCard): Hex {
  const stable: Record<string, CanonicalValue> = { ...(card as unknown as Record<string, CanonicalValue>) };
  delete stable["url"];

  const extension = stable["x-mandate"];
  if (extension !== null && typeof extension === "object" && !Array.isArray(extension)) {
    const { agentId: _omitted, ...rest } = extension as Record<string, CanonicalValue>;
    stable["x-mandate"] = rest;
  }

  return canonicalHash(stable);
}

/** Trailing slashes change the card hash's neighbours and nothing else, so they are normalised away. */
function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") && url.length > 1 ? url.slice(0, -1) : url;
}

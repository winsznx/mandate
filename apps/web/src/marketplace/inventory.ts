/**
 * The marketplace inventory, read from what has actually been published.
 *
 * Three files back everything on the listing surfaces, and none of them is a
 * database: the agent cards the ERC-8004 registrations point at, the proof
 * manifests each completed run wrote, and the deployment record for the
 * registry those runs published into. If a category has no card here it has no
 * agents, and the interface says so rather than filling the space.
 *
 * Nothing in this module reaches the network. Chain confirmation and endpoint
 * liveness are separate modules, so an agent's file-level facts stay testable
 * without an RPC and a page can still render when the chain is unreachable.
 */
import { AgentCategorySchema } from "@mandate/domain";
import type { AgentCategory } from "@mandate/domain";
import { z } from "zod";
import { listDirectories, listJsonFiles, readJsonFile } from "./repo-files";

const AGENTS_DIR = "artifacts/agents";
const EVIDENCE_DIR = "artifacts/evidence";
const DEPLOYMENT_FILE = "contracts/deployments/97.json";

/* -------------------------------------------------------------------------- */
/*  Agent cards                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Deliberately permissive beyond the fields the interface renders.
 *
 * These cards are written by whoever publishes an agent, and a card carrying a
 * field this app has never heard of is not a malformed card. What is required
 * is only what the marketplace cannot honestly present without: an identity, a
 * category, and at least one declared skill.
 */
const SkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
});

const MandateExtensionSchema = z.object({
  category: AgentCategorySchema,
  /**
   * The ERC-8004 identity this card belongs to, when the publisher states it.
   *
   * Optional because the binding that actually counts runs the other way: the
   * registration on chain points at the card. A declared id is a convenience
   * for finding the registration, and it is checked against the chain rather
   * than believed.
   */
  agentId: z.string().optional(),
  identityRegistry: z.string().optional(),
  referenceAgent: z.boolean().default(false),
  proposesOnly: z.boolean().optional(),
  hosting: z.string().optional(),
  scaffold: z.string().optional(),
  /**
   * The publisher's own word on whether the strategy behind the card exists.
   *
   * Read and displayed rather than inferred. A scaffold that says so is more
   * useful than one the marketplace quietly ranks last.
   */
  strategyStatus: z.string().optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
  policyHash: z.string().optional(),
});

const AgentCardSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  url: z.string().optional(),
  version: z.string().optional(),
  protocolVersion: z.string().optional(),
  preferredTransport: z.string().optional(),
  skills: z.array(SkillSchema).default([]),
  "x-mandate": MandateExtensionSchema,
});

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface PublishedAgentCard {
  /** The file it came from, so a reader can go and check it. */
  file: string;
  /** The file's base name, which is how a registration URI names it. */
  slug: string;
  name: string;
  declaredAgentId: string | undefined;
  description: string;
  /** Where the publisher says the agent answers. Absent when none is declared. */
  url: string | undefined;
  version: string | undefined;
  preferredTransport: string | undefined;
  category: AgentCategory;
  referenceAgent: boolean;
  proposesOnly: boolean | undefined;
  hosting: string | undefined;
  strategyStatus: string | undefined;
  policy: Record<string, unknown> | undefined;
  policyHash: string | undefined;
  skills: AgentSkill[];
}

export interface UnreadableCard {
  file: string;
  reason: string;
}

export interface AgentCardIndex {
  cards: PublishedAgentCard[];
  /**
   * Cards that exist but could not be read.
   *
   * Surfaced rather than dropped: a card silently missing from a category page
   * is indistinguishable from a category nobody has built for, and those are
   * very different facts.
   */
  unreadable: UnreadableCard[];
}

export function loadAgentCards(): AgentCardIndex {
  const cards: PublishedAgentCard[] = [];
  const unreadable: UnreadableCard[] = [];

  for (const file of listJsonFiles(AGENTS_DIR)) {
    const path = `${AGENTS_DIR}/${file}`;
    const raw = readJsonFile(path);
    if (raw === undefined) {
      unreadable.push({ file, reason: "the file could not be read or is not valid JSON" });
      continue;
    }
    const parsed = AgentCardSchema.safeParse(raw);
    if (!parsed.success) {
      unreadable.push({ file, reason: firstIssue(parsed.error) });
      continue;
    }

    const extension = parsed.data["x-mandate"];
    cards.push({
      file: path,
      slug: file.replace(/\.json$/, ""),
      declaredAgentId: extension.agentId,
      name: parsed.data.name,
      description: parsed.data.description,
      url: parsed.data.url,
      version: parsed.data.version,
      preferredTransport: parsed.data.preferredTransport,
      category: extension.category,
      referenceAgent: extension.referenceAgent,
      proposesOnly: extension.proposesOnly,
      hosting: extension.hosting,
      strategyStatus: extension.strategyStatus,
      policy: extension.policy,
      policyHash: extension.policyHash,
      skills: parsed.data.skills,
    });
  }

  return { cards, unreadable };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "the card did not match the agent-card schema";
  const path = issue.path.join(".");
  return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
}

/* -------------------------------------------------------------------------- */
/*  Published runs                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A completed run's manifest, read for the handful of fields the marketplace
 * needs to locate its evidence on chain.
 *
 * The manifest is the run's own record and nothing on chain commits to it, so
 * every id taken from here is treated as a candidate to be confirmed against
 * the registry, never as a fact in itself.
 */
const RunManifestSchema = z.object({
  runId: z.string().min(1),
  status: z.string().optional(),
  agent: z.object({
    agentId: z.string().min(1),
    identityRegistry: z.string().min(1),
  }),
  network: z.object({ chainId: z.number(), name: z.string() }).optional(),
  trial: z
    .object({
      result: z.string().optional(),
      forkBlock: z.string().optional(),
      testedAuthorityHash: z.string().optional(),
      replayDerived: z.string().optional(),
      rpcSourceClass: z.string().optional(),
    })
    .optional(),
  receipt: z
    .object({
      receiptId: z.string().optional(),
      evidenceURI: z.string().optional(),
      publishTxHash: z.string().optional(),
      publisher: z.string().optional(),
    })
    .optional(),
  mandate: z
    .object({
      mandateId: z.string().optional(),
      disclosureURI: z.string().optional(),
      grantedAuthorityHash: z.string().optional(),
      revokedAt: z.number().optional(),
      wallet: z.string().optional(),
    })
    .optional(),
});

export interface PublishedRun {
  runId: string;
  directory: string;
  agentId: string;
  identityRegistry: string;
  chainId: number | undefined;
  trialResult: string | undefined;
  forkBlock: string | undefined;
  testedAuthorityHash: string | undefined;
  receiptId: string | undefined;
  evidenceUri: string | undefined;
  mandateId: string | undefined;
  disclosureUri: string | undefined;
}

/**
 * Every run that published a manifest, newest first.
 *
 * Run directories are UTC timestamps, so a plain reverse sort is chronological.
 */
export function loadPublishedRuns(): PublishedRun[] {
  const runs: PublishedRun[] = [];

  for (const directory of listDirectories(EVIDENCE_DIR)) {
    const raw = readJsonFile(`${EVIDENCE_DIR}/${directory}/proof-manifest.json`);
    if (raw === undefined) continue;
    const parsed = RunManifestSchema.safeParse(raw);
    if (!parsed.success) continue;

    const manifest = parsed.data;
    runs.push({
      runId: manifest.runId,
      directory,
      agentId: manifest.agent.agentId,
      identityRegistry: manifest.agent.identityRegistry.toLowerCase(),
      chainId: manifest.network?.chainId,
      trialResult: manifest.trial?.result,
      forkBlock: manifest.trial?.forkBlock,
      testedAuthorityHash: manifest.trial?.testedAuthorityHash,
      receiptId: manifest.receipt?.receiptId,
      evidenceUri: manifest.receipt?.evidenceURI,
      mandateId: manifest.mandate?.mandateId,
      disclosureUri: manifest.mandate?.disclosureURI,
    });
  }

  return runs.sort((a, b) => (a.directory < b.directory ? 1 : a.directory > b.directory ? -1 : 0));
}

/** Runs for one agent id, newest first. */
export function runsForAgent(runs: readonly PublishedRun[], agentId: string): PublishedRun[] {
  return runs.filter((run) => run.agentId === agentId);
}

/* -------------------------------------------------------------------------- */
/*  Deployment record                                                         */
/* -------------------------------------------------------------------------- */

const DeploymentSchema = z.object({
  chainId: z.number(),
  network: z.string(),
  address: z.string(),
  txHash: z.string(),
  deployer: z.string(),
  blockNumber: z.number(),
  broadcastAt: z.string(),
  compilation: z
    .object({
      solc: z.string(),
      evmVersion: z.string(),
      optimizer: z.boolean(),
      optimizerRuns: z.number(),
    })
    .optional(),
  commit: z.object({ sha: z.string(), dirty: z.boolean() }).optional(),
  verification: z
    .object({ verifier: z.string(), status: z.string(), checkedAt: z.string().optional() })
    .optional(),
});

export type DeploymentRecord = z.infer<typeof DeploymentSchema>;

/** The registry deployment as recorded at broadcast, or `undefined` if unreadable. */
export function loadDeployment(): DeploymentRecord | undefined {
  const raw = readJsonFile(DEPLOYMENT_FILE);
  if (raw === undefined) return undefined;
  const parsed = DeploymentSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

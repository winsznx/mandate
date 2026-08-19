/**
 * The rung an agent is shown at, and the reason it is that rung.
 *
 * Two ladders meet here. `provenance.ts` grades how a claim about an agent was
 * established; `qualification.ts` grades how far the agent has proven it can be
 * hired at all. The interface never renders a stored provenance directly:
 * `displayProvenance` clamps the evidence label to what the agent's current
 * qualification can support, and when it clamps, the page says so.
 *
 * That clamp is the honest part of this file. An agent can hold real on-chain
 * evidence and still have a dead endpoint today, and a marketplace that kept
 * advertising the evidence would be selling something that cannot be bought.
 * Both facts are carried through to the page: the rung the evidence would
 * support, the rung actually shown, and the sentence that separates them.
 */
import {
  assessQualification,
  displayProvenance,
  provenanceCeilingFor,
  provenanceRank,
  EVIDENCE_PROVENANCE,
} from "@mandate/domain";
import type {
  DisqualificationReason,
  EvidenceProvenance,
  QualificationAssessment,
  QualificationStage,
} from "@mandate/domain";
import type { Address, Hex } from "viem";
import { IDENTITY_REGISTRY } from "../proof/config";
import type { Category } from "./categories";
import { categoryByKey } from "./categories";
import type { ActivationFact, IdentityFact, ReceiptFact } from "./chain-facts";
import { readActivationFact, readIdentity, readReceiptFact } from "./chain-facts";
import type { EndpointProbe } from "./endpoint";
import { endpointAnswered, endpointRequiresAuth, probeEndpoint } from "./endpoint";
import type { PublishedAgentCard, PublishedRun } from "./inventory";
import { loadAgentCards, loadPublishedRuns, runsForAgent } from "./inventory";

/* -------------------------------------------------------------------------- */
/*  The ladder, described                                                     */
/* -------------------------------------------------------------------------- */

export interface Rung {
  provenance: EvidenceProvenance;
  /** 0 through 5. Rendered as a numeral beside the name so the rung never depends on colour. */
  rank: number;
  /** A glyph, so the rung survives greyscale and a screenshot. */
  glyph: string;
  /** What the rung asserts. */
  meaning: string;
  /** What has to be true before an agent may be shown at it. */
  requirement: string;
  /** What it still does not tell a reader. */
  limit: string;
}

export const RUNGS: readonly Rung[] = [
  {
    provenance: "Claimed",
    rank: 0,
    glyph: "○",
    meaning: "The developer says so. Nothing else does.",
    requirement: "A published agent card. Anyone can write one.",
    limit: "No part of this has been checked. It never grants authority over a wallet.",
  },
  {
    provenance: "Public Activity",
    rank: 1,
    glyph: "◔",
    meaning: "A public BSC event exists that looks like this behaviour.",
    requirement: "An on-chain event consistent with the claim.",
    limit: "The link between that event and this agent is unproven. Anyone can act like anyone.",
  },
  {
    provenance: "Identity-bound",
    rank: 2,
    glyph: "◑",
    meaning: "The acting address is tied to the agent's ERC-8004 identity.",
    requirement: "A registration on the identity registry that resolves to this agent's card.",
    limit: "It says who acted. It says nothing about whether they acted well.",
  },
  {
    provenance: "Trial-verified",
    rank: 3,
    glyph: "◕",
    meaning: "This version of the agent passed a reproducible MANDATE trial.",
    requirement:
      "A trial receipt in the live registry, marked passed, still fresh, whose evidence hashes to the document the receipt committed to.",
    limit: "A trial is one scenario on a pinned fork. It is not a track record.",
  },
  {
    provenance: "Mandate-native",
    rank: 4,
    glyph: "●",
    meaning: "The agent acted through a real MANDATE session, so attribution is direct.",
    requirement:
      "An activation in the live registry pointing at that same trial receipt, with the execution disclosed and readable on chain.",
    limit: "It shows the boundary held. It does not show the agent was profitable.",
  },
  {
    provenance: "Mandate-verified",
    rank: 5,
    glyph: "◉",
    meaning: "A mandate-native execution was re-checked against the independent reference model.",
    requirement: "The reference model replayed against the recorded observation and agreed.",
    limit: "The replay needs the model's own source, which a browser does not have.",
  },
];

export function rungFor(provenance: EvidenceProvenance): Rung {
  const rung = RUNGS.find((entry) => entry.provenance === provenance);
  if (rung === undefined) throw new Error(`no rung described for provenance ${provenance}`);
  return rung;
}

export const RUNG_COUNT = EVIDENCE_PROVENANCE.length;

/* -------------------------------------------------------------------------- */
/*  Why an agent stopped where it did                                         */
/* -------------------------------------------------------------------------- */

/**
 * Each disqualification reason, said as an observation rather than a verdict.
 *
 * `qualification.ts` names the machine reason. This map is what a reader is
 * owed: what was looked at, and what was found. In particular nothing here
 * asserts that an unchecked thing failed — "no trial has handed this agent a
 * task" is a different statement from "this agent rejected the task", and the
 * second one would be a claim MANDATE has no evidence for.
 */
const DISQUALIFICATION_WORDING: Record<DisqualificationReason, string> = {
  URI_UNRESOLVABLE: "The identity registration does not resolve to a document this page could read.",
  URI_NOT_JSON: "The registration URI answered, but not with JSON.",
  REGISTRATION_MALFORMED: "The registration resolves, but the document is not a well-formed agent card.",
  NO_SERVICES_DECLARED: "The card declares no skill, so there is no service to offer.",
  ENDPOINT_UNREACHABLE:
    "The declared endpoint did not answer when this page loaded, so nothing here shows the agent is running.",
  ENDPOINT_TIMEOUT: "The declared endpoint did not answer within the timeout.",
  ENDPOINT_REJECTED_HANDSHAKE: "The endpoint answered, but not with an agent card.",
  ENDPOINT_REQUIRES_AUTH:
    "The endpoint is running but will not describe itself without a credential, so it cannot be listed as callable.",
  NO_CATEGORY_DECLARED: "The card declares no MANDATE category.",
  CATEGORY_TASK_UNSUPPORTED:
    "No MANDATE trial has handed this agent a task in this category, so nothing here shows it accepts one.",
  BULK_MINT_PUBLISHER:
    "The publisher is a known bulk minter, so the registration alone is not treated as evidence of an agent.",
  NO_CURRENT_TRIAL: "No current passing trial receipt for this agent exists in the live registry.",
  TRIAL_FAILED: "The most recent trial receipt is marked failed.",
};

export function disqualificationWording(reason: DisqualificationReason): string {
  return DISQUALIFICATION_WORDING[reason];
}

/* -------------------------------------------------------------------------- */
/*  A listed agent                                                            */
/* -------------------------------------------------------------------------- */

export interface AgentListing {
  card: PublishedAgentCard;
  category: Category;
  /** Present only once the chain confirms a registration behind this card. */
  agentId: string | undefined;
  identityRegistry: Address;
  identity: IdentityFact;
  endpoint: EndpointProbe;
  latestRun: PublishedRun | undefined;
  receipt: ReceiptFact | undefined;
  activation: ActivationFact | undefined;
  qualification: QualificationAssessment;
  /** The rung the evidence on its own would support. */
  evidenceProvenance: EvidenceProvenance;
  /** The rung actually shown, never stronger than the qualification allows. */
  provenance: EvidenceProvenance;
  clamped: boolean;
  /** Set when `clamped`. The sentence the interface prints instead of downgrading quietly. */
  clampReason: string | undefined;
  /** What has actually been established, each line traceable to an artifact or a chain read. */
  proved: string[];
  /** What has not been established yet, and why. */
  outstanding: string[];
  /** True when any chain read failed, so the page can say the rung may be understated. */
  chainUnreadable: boolean;
}

/**
 * Build one listing.
 *
 * Every signal handed to `assessQualification` is an observation made in this
 * request: a registry read, a probe, a receipt lookup. Nothing is remembered
 * from a previous build, because a stale "callable" is the single most
 * misleading thing a marketplace can print.
 */
export async function buildListing(
  card: PublishedAgentCard,
  runs: readonly PublishedRun[],
  now: number,
): Promise<AgentListing> {
  const category = categoryByKey(card.category);
  if (category === undefined) throw new Error(`agent card ${card.file} declares unknown category`);

  const endpoint = await probeEndpoint(card.url);
  const candidateId = card.declaredAgentId ?? agentIdFromRuns(card, runs);

  const identity: IdentityFact =
    candidateId === undefined
      ? { observed: "ABSENT", registrationUri: undefined, owner: undefined, reason: undefined }
      : await readIdentity(candidateId);

  const registrationNamesThisCard =
    identity.observed === "CONFIRMED" &&
    identity.registrationUri !== undefined &&
    identity.registrationUri.endsWith(`/${card.slug}.json`);

  const agentId = registrationNamesThisCard ? candidateId : undefined;
  const latestRun = agentId === undefined ? undefined : runsForAgent(runs, agentId)[0];

  const receipt =
    latestRun?.receiptId === undefined ? undefined : await readReceiptFact(latestRun.receiptId as Hex);
  const activation =
    latestRun?.mandateId === undefined ? undefined : await readActivationFact(latestRun.mandateId as Hex);

  const trialIsCurrent =
    receipt?.observed === "CONFIRMED" && receipt.passed && receipt.freshUntil > now;
  const mandateNative =
    trialIsCurrent &&
    activation?.observed === "CONFIRMED" &&
    activation.trialReceiptId?.toLowerCase() === receipt?.receiptId?.toLowerCase();

  const qualification = assessQualification(
    {
      registrationResolves: registrationNamesThisCard,
      registrationWellFormed: true,
      declaresService: card.skills.length > 0,
      endpointAnswered: endpointAnswered(endpoint),
      endpointRequiresAuth: endpointRequiresAuth(endpoint),
      declaresCategory: true,
      // Direct evidence only: a trial handed this agent a task in its category
      // and the agent answered. An endpoint that merely serves a card has not
      // shown that.
      acceptsCategoryTask: latestRun !== undefined,
      hasCurrentPassingTrial: trialIsCurrent,
      hasMandateNativeExecution: mandateNative,
      publisherIsBulkMinter: false,
    },
    now,
  );

  const evidenceProvenance: EvidenceProvenance = mandateNative
    ? "Mandate-native"
    : trialIsCurrent
      ? "Trial-verified"
      : registrationNamesThisCard
        ? "Identity-bound"
        : "Claimed";

  const shown = displayProvenance(evidenceProvenance, qualification.stage);

  return {
    card,
    category,
    agentId,
    identityRegistry: IDENTITY_REGISTRY,
    identity,
    endpoint,
    latestRun,
    receipt,
    activation,
    qualification,
    evidenceProvenance,
    provenance: shown.provenance,
    clamped: shown.clamped,
    clampReason: shown.clamped
      ? clampReason(evidenceProvenance, shown.provenance, qualification.stage)
      : undefined,
    proved: provedLines({ card, identity, registrationNamesThisCard, latestRun, receipt, activation, mandateNative, trialIsCurrent }),
    outstanding: qualification.blockedBy.map(disqualificationWording),
    chainUnreadable:
      identity.observed === "UNREADABLE" ||
      receipt?.observed === "UNREADABLE" ||
      activation?.observed === "UNREADABLE",
  };
}

function clampReason(
  evidence: EvidenceProvenance,
  shown: EvidenceProvenance,
  stage: QualificationStage,
): string {
  return (
    `Its published evidence would support ${evidence}, but an agent at qualification stage ` +
    `${stage.replace(/_/g, " ").toLowerCase()} may be shown no higher than ${provenanceCeilingFor(stage)}. ` +
    `The rung above is the capped one. Evidence you cannot currently act on is history, not an offer.`
  );
}

/**
 * The binding between a card and an identity, resolved the way that binding is
 * actually made: the registration on chain names the card, not the other way
 * round.
 */
function agentIdFromRuns(card: PublishedAgentCard, runs: readonly PublishedRun[]): string | undefined {
  const candidates = new Set(runs.map((run) => run.agentId));
  if (candidates.size === 1) {
    const only = [...candidates][0];
    return only;
  }
  // With several agents in play the card's own declaration is required. Guessing
  // which registration belongs to which card would attribute one agent's proof
  // to another, which is the worst error this surface could make.
  return card.declaredAgentId;
}

function provedLines(input: {
  card: PublishedAgentCard;
  identity: IdentityFact;
  registrationNamesThisCard: boolean;
  latestRun: PublishedRun | undefined;
  receipt: ReceiptFact | undefined;
  activation: ActivationFact | undefined;
  mandateNative: boolean;
  trialIsCurrent: boolean;
}): string[] {
  const lines: string[] = [];

  if (input.registrationNamesThisCard && input.identity.registrationUri !== undefined) {
    lines.push(
      `The ERC-8004 identity registry resolves this agent to the card at ${input.identity.registrationUri}, so the card is a public commitment rather than a file in a repository.`,
    );
  }

  if (input.trialIsCurrent && input.latestRun !== undefined) {
    lines.push(
      `A trial receipt is in the live registry and marked passed, produced on a fork pinned at block ${input.latestRun.forkBlock ?? "an unrecorded block"}, with the evidence document hashing to what the receipt committed to.`,
    );
  }

  if (input.mandateNative && input.activation !== undefined) {
    lines.push(
      input.activation.revokedAt === 0
        ? "A mandate activated against that receipt and is on chain now."
        : "A mandate activated against that receipt, ran, and was revoked. The whole lifecycle is reconstructible from the registry.",
    );
  }

  if (lines.length === 0) {
    lines.push(
      "Nothing beyond the card itself. The description above is the developer's account of what this agent does.",
    );
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/*  Whole-marketplace assembly                                                */
/* -------------------------------------------------------------------------- */

export interface Marketplace {
  listings: AgentListing[];
  unreadable: { file: string; reason: string }[];
  observedAt: number;
}

export async function loadMarketplace(now: number): Promise<Marketplace> {
  const { cards, unreadable } = loadAgentCards();
  const runs = loadPublishedRuns();
  const listings = await Promise.all(cards.map((card) => buildListing(card, runs, now)));

  return {
    listings: listings.sort(byStrength),
    unreadable,
    observedAt: now,
  };
}

/**
 * Strongest first, and provenance dominates.
 *
 * A card's claimed metrics can never sort it above an agent that completed a
 * trial, because a claim and a trial are not the same kind of statement and
 * ordering them together would imply they were.
 */
function byStrength(a: AgentListing, b: AgentListing): number {
  const rung = provenanceRank(b.provenance) - provenanceRank(a.provenance);
  if (rung !== 0) return rung;
  return a.card.name.localeCompare(b.card.name);
}

export function listingsInCategory(marketplace: Marketplace, category: Category): AgentListing[] {
  return marketplace.listings.filter((listing) => listing.category.slug === category.slug);
}

/** The strongest rung anything in this category reaches, or undefined when it is empty. */
export function categoryCeiling(listings: readonly AgentListing[]): EvidenceProvenance | undefined {
  let strongest: EvidenceProvenance | undefined;
  for (const listing of listings) {
    if (strongest === undefined || provenanceRank(listing.provenance) > provenanceRank(strongest)) {
      strongest = listing.provenance;
    }
  }
  return strongest;
}

/**
 * Wiring the first reference agent into a trial.
 *
 * The agent is constructed against the FORK endpoint, not the public RPC. That
 * one detail decides whether the trial means anything: an executor wired to the
 * live chain would answer about a position the scenario never created, and would
 * then pass or fail on it. `runTrial` hands the endpoint in for exactly this
 * reason, and this module does nothing with it except build the same reader the
 * agent's own process entry point builds.
 *
 * Nothing here judges the agent. The verdict comes from the evaluator, the
 * expectation it is measured against comes from the reference model, and this
 * file is not allowed to know what either of them concluded.
 */
import { randomBytes } from "node:crypto";
import { canonicalHash } from "@mandate/domain";
import type { Hex } from "viem";
import { createChainClient } from "@mandate/agent-runtime";
import type { AgentExecutor } from "@mandate/agent-runtime";
import { createHealthFactorStrategy } from "@mandate/agent-health-factor-a";
import { CONSERVATIVE_GUARDIAN_POLICY } from "@mandate/agent-health-factor-a/policy";
import {
  createVenusReader,
  venusDeploymentFor as agentVenusDeploymentFor,
} from "@mandate/agent-health-factor-a/venus";
import { referenceImplementationHash, type ReferencePolicy } from "@mandate/reference-health-factor";
import { evaluatorImplementationHash, type TrialRequest } from "@mandate/trial-runner";
import { venusDeploymentFor } from "@mandate/venus-bsc";
import { REPAY_BORROW_SELECTOR, DAILY_SPEND_CAP_RAW } from "./plan.js";
import type { ScenarioBuild } from "./scenario.js";

export const AGENT_SLUG = "health-factor-a";
export const AGENT_DISPLAY_NAME = "Conservative Guardian";
export const AGENT_DESCRIPTION =
  "Defends a Venus Core-pool borrow position on BNB Smart Chain. Intervenes when the " +
  "liquidation-threshold-weighted health factor falls below 1.30 and proposes a repayBorrow " +
  "that restores it to 1.35. Reference agent built from the BNB Agent Studio scaffold and " +
  "self-hosted by the MANDATE team.";

/**
 * Where the agent is published, for the record.
 *
 * A repo identity rather than the fork's `http://127.0.0.1:<port>`, which is a
 * different string on every run and names nothing a reader could ever reach.
 */
export const AGENT_PUBLISHED_ENDPOINT = "mandate://agents/reference/health-factor-a";

export const RESTORE_HEALTH_FACTOR_SKILL_ID = "restore-health-factor";

/**
 * Tolerance between the agent's repayment and the reference model's.
 *
 * Interest accrues and the exchange rate moves between the two reconstructions,
 * so some drift is expected. 50 bps on an 18-USDT repayment is under a tenth of
 * a cent, which is wide enough for rounding and far too narrow to hide a sizing
 * error.
 */
export const AMOUNT_TOLERANCE_BPS = 50;

/**
 * The reference model's policy, derived from the agent's own.
 *
 * Derived rather than restated so the two cannot drift into measuring different
 * things. What stays independent is the arithmetic: the agent and the model
 * share these thresholds and share no code that turns them into a number.
 */
export function referencePolicy(): ReferencePolicy {
  return {
    policyId: CONSERVATIVE_GUARDIAN_POLICY.policyId,
    interventionThresholdMantissa: CONSERVATIVE_GUARDIAN_POLICY.interventionThresholdMantissa,
    targetHealthFactorMantissa: CONSERVATIVE_GUARDIAN_POLICY.targetHealthFactorMantissa,
    minimumRepayUsdMantissa: CONSERVATIVE_GUARDIAN_POLICY.minimumRepayUsdMantissa,
    amountToleranceBps: AMOUNT_TOLERANCE_BPS,
  };
}

/**
 * Build the reference agent as it will be asked, pointed wherever the caller says.
 *
 * `fallbackRpcUrl` is deliberately absent. The runtime's default fallback is the
 * public BSC endpoint, and a fork read that quietly failed over to it would have
 * the agent reasoning about the live chain while the trial believed it was
 * reasoning about the scenario. That failure would look like a disagreement
 * between the agent and the model rather than like a misconfiguration.
 */
export function createReferenceAgent(chainId: number, rpcUrl: string): AgentExecutor {
  const deployment = agentVenusDeploymentFor(chainId);
  const client = createChainClient({
    host: "127.0.0.1",
    port: 0,
    publicUrl: AGENT_PUBLISHED_ENDPOINT,
    chainId,
    rpcUrl,
    fallbackRpcUrl: undefined,
    logLevel: "error",
  });
  return createHealthFactorStrategy({
    slug: AGENT_SLUG,
    displayName: AGENT_DISPLAY_NAME,
    description: AGENT_DESCRIPTION,
    policy: CONSERVATIVE_GUARDIAN_POLICY,
    deployment,
    reader: createVenusReader(client, deployment),
  });
}

export function skillHashesOf(executor: AgentExecutor): Hex[] {
  return executor.skills.map((skill) => canonicalHash(skill.id));
}

/** Identity of the code that judges, and of the code that predicts. */
export function trialImplementationHashes(): { evaluatorCodeHash: Hex; referenceModelHash: Hex } {
  return {
    evaluatorCodeHash: evaluatorImplementationHash(),
    referenceModelHash: referenceImplementationHash(),
  };
}

export function freshNonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}

/**
 * Assemble the request the trial engine runs.
 *
 * `spendCapRawUnits` is the tested cap and not the scenario's repayment: the
 * evaluator's job is to catch an agent proposing more than the authority was
 * tested for, so handing it the amount the scenario expected would make that
 * check tautological.
 */
export function buildTrialRequest(params: {
  chainId: number;
  build: ScenarioBuild;
  trialSpec: TrialRequest["trialSpec"];
  parameters: Readonly<Record<string, unknown>>;
}): TrialRequest {
  return {
    scenario: params.build.scenario,
    trialSpec: params.trialSpec,
    createExecutor: (endpoint: string) => createReferenceAgent(params.chainId, endpoint),
    publishedEndpoint: AGENT_PUBLISHED_ENDPOINT,
    protocol: "REFERENCE",
    skill: RESTORE_HEALTH_FACTOR_SKILL_ID,
    parameters: params.parameters,
    policy: referencePolicy(),
    deployment: venusDeploymentFor(params.chainId),
    authorisedSelector: REPAY_BORROW_SELECTOR,
    spendCapRawUnits: DAILY_SPEND_CAP_RAW,
  };
}

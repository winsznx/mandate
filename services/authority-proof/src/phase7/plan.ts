/**
 * The demo, as documents rather than as a narration.
 *
 * Everything the Phase 7 sequence is about — which contract, which selector,
 * which cap, which two amounts, how large the standing allowance has to be — is
 * decided here and nowhere else, so the trial, the compiler, the grant and the
 * manifest cannot disagree about what was being proved.
 *
 * The two amounts are `00-DECISIONS.md` §4.4's sequence: 20 succeeds, 6 is
 * rejected because the cumulative bucket total would reach 26 against a cap of
 * 25. The interesting number is the second one, and the whole of
 * `standingAllowancePlan` exists to make sure the thing that rejects it is the
 * spend cap.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalHash, ProtocolSafetyProfileSchema } from "@mandate/domain";
import type {
  AgentRef,
  AuthorityIR,
  CanonicalValue,
  ProtocolSafetyProfile,
  TrialSpec,
} from "@mandate/domain";
import {
  AUTHORITY_IR_SCHEMA_VERSION,
  closedDownstreamPolicy,
  emptyDurableEffects,
  TRIAL_SPEC_SCHEMA_VERSION,
  TrialSpecSchema,
  UNBOUND_WALLET,
} from "@mandate/domain";
import { standingAllowanceFor } from "@mandate/authority-compiler";
import type { AgentExecutor } from "@mandate/agent-runtime";
import type { Address, Hex } from "viem";

export const REPAY_BORROW_SIGNATURE = "repayBorrow(uint256)" as const;
export const REPAY_BORROW_SELECTOR: Hex = "0x0e752702";
/** `borrow(uint256)`. Granted nowhere, submitted once, expected to be refused. */
export const BORROW_SELECTOR: Hex = "0xc5ebeaec";

/** The mock USDT on testnet is 6 decimals, so 25 USDT is 25e6 and not 25e18. */
export const USDT_DECIMALS = 6;
const USDT_UNIT = 10n ** BigInt(USDT_DECIMALS);

export const DAILY_SPEND_CAP_RAW = 25n * USDT_UNIT;
/** Succeeds. Leaves 5 of the bucket's 25 unspent. */
export const AT_CAP_REPAY_RAW = 20n * USDT_UNIT;
/** Fails. 20 + 6 = 26 against a cap of 25. */
export const BREACH_REPAY_RAW = 6n * USDT_UNIT;

/** Fee headroom for the relay, per `00-DECISIONS.md` §3.5 point 1. Declared, never inferred. */
export const NATIVE_DAILY_CAP_WEI = 2n * 10n ** 16n;

export const MANDATE_LIFETIME_SECONDS = 7 * 24 * 3_600;

/** How long a passing trial stays current. Matches the mandate lifetime. */
export const EVIDENCE_MAX_AGE_SECONDS = MANDATE_LIFETIME_SECONDS;

export interface AllowancePlan {
  standingAllowance: bigint;
  /** What the allowance still permits once the at-cap repayment has consumed its share. */
  remainingAfterAtCap: bigint;
  /**
   * True when the spend cap, and not the ERC-20 allowance, is what stops the
   * breach attempt.
   *
   * This is the assertion the whole demo turns on. With an allowance sized to
   * one period instead of the lifetime, 20 leaves 5, the 6 reverts
   * `BEP20: transfer amount exceeds allowance`, and the run reports a bounded
   * mandate while the binding constraint was a MANDATE bug.
   */
  capBindsBreach: boolean;
  /** How much more allowance than breach amount is available. Negative means misconfigured. */
  headroom: bigint;
}

/**
 * Size the standing allowance and prove the cap is the binding constraint.
 *
 * Deliberately computed rather than asserted, and checked in preflight where it
 * costs nothing, because by the time the breach reverts it is too late to
 * discover which ceiling produced the revert.
 */
export function standingAllowancePlan(
  params: {
    periodLimit?: bigint;
    lifetimeSeconds?: number;
    atCapAmount?: bigint;
    breachAmount?: bigint;
  } = {},
): AllowancePlan {
  const periodLimit = params.periodLimit ?? DAILY_SPEND_CAP_RAW;
  const atCapAmount = params.atCapAmount ?? AT_CAP_REPAY_RAW;
  const breachAmount = params.breachAmount ?? BREACH_REPAY_RAW;

  const standingAllowance = standingAllowanceFor({
    periodLimit,
    period: "day",
    lifetimeSeconds: params.lifetimeSeconds ?? MANDATE_LIFETIME_SECONDS,
  });

  const remainingAfterAtCap = standingAllowance - atCapAmount;
  return {
    standingAllowance,
    remainingAfterAtCap,
    capBindsBreach: remainingAfterAtCap >= breachAmount,
    headroom: remainingAfterAtCap - breachAmount,
  };
}

/**
 * Identity of the agent build under test.
 *
 * Hashed from what the executor itself declares — its slug, category, skills and
 * policy — rather than from a version string somebody maintains. `00-DECISIONS.md`
 * B3 records that no build identity exists anywhere upstream, so this commits to
 * the agent's declared surface and says so, instead of implying a reproducible
 * build hash the ecosystem does not yet provide.
 */
export function agentVersionHashOf(executor: AgentExecutor): Hex {
  const document: CanonicalValue = {
    slug: executor.slug,
    displayName: executor.displayName,
    description: executor.description,
    category: executor.category,
    skills: executor.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags],
    })),
    policy: executor.policy,
  };
  return canonicalHash(document);
}

export interface AuthorityInputs {
  chainId: number;
  vToken: Address;
  underlying: Address;
  /** `implementationCodeHash` from the profile. A change invalidates the grant. */
  protocolVersionHash: Hex;
  agentIdentity: AgentRef;
  agentVersionHash: Hex;
}

/**
 * The envelope the trial certifies.
 *
 * `wallet` is the zero address because a tested authority belongs to an agent
 * version and not to any user, and the whole point of the receipt is that a
 * second user can derive their own mandate from the same evidence.
 */
export function buildTestedAuthority(inputs: AuthorityInputs): AuthorityIR {
  return {
    schemaVersion: AUTHORITY_IR_SCHEMA_VERSION,
    chainId: inputs.chainId,
    subject: {
      wallet: UNBOUND_WALLET,
      agentIdentity: inputs.agentIdentity,
      agentVersionHash: inputs.agentVersionHash,
    },
    calls: [
      {
        target: inputs.vToken,
        selector: REPAY_BORROW_SELECTOR,
        signature: REPAY_BORROW_SIGNATURE,
        protocolId: "venus",
        protocolVersionHash: inputs.protocolVersionHash,
      },
    ],
    spend: [
      { token: inputs.underlying, limit: DAILY_SPEND_CAP_RAW.toString(10), period: "day" },
      { token: "NATIVE", limit: NATIVE_DAILY_CAP_WEI.toString(10), period: "day" },
    ],
    durableEffects: emptyDurableEffects(),
    downstreamPolicy: closedDownstreamPolicy(),
    lifetime: { maxDurationSeconds: MANDATE_LIFETIME_SECONDS },
  };
}

/**
 * What is actually granted to one wallet.
 *
 * Identical to the tested envelope apart from the subject and the concrete
 * deadline, plus the one durable effect the mandate really creates. The
 * allowance is declared here so the compiler warns about it and the proof page
 * can show it, rather than it existing only as a transaction nobody labelled.
 */
export function buildGrantedAuthority(
  inputs: AuthorityInputs & { wallet: Address; expiry: number; standingAllowance: bigint },
): AuthorityIR {
  const tested = buildTestedAuthority(inputs);
  return {
    ...tested,
    subject: { ...tested.subject, wallet: inputs.wallet.toLowerCase() as Address },
    durableEffects: {
      approvals: [
        {
          token: inputs.underlying,
          spender: inputs.vToken,
          maxAmount: inputs.standingAllowance.toString(10),
          createdBy: "ADMIN",
          // The account force-zeroes session-path approvals but never touches an
          // admin-path one, so revocation leaves this behind and the user has to
          // be told.
          expiresWithSession: false,
          cleanupRequired: true,
        },
      ],
      signatureCheckers: [],
      other: [],
    },
    lifetime: { maxDurationSeconds: MANDATE_LIFETIME_SECONDS, notAfter: inputs.expiry },
  };
}

export interface TrialSpecInputs {
  chainId: number;
  snapshotBlock: bigint;
  nonce: Hex;
  agentIdentity: AgentRef;
  agentVersionHash: Hex;
  registrationUriHash: Hex;
  endpointHash: Hex;
  skillHashes: readonly Hex[];
  testedAuthority: AuthorityIR;
  scenarioId: string;
  scenarioVersion: string;
  scenarioHash: Hex;
  evaluatorCodeHash: Hex;
  referenceModelHash: Hex;
  taskInputHash: Hex;
  taskParametersHash: Hex;
  createdAt: number;
}

/**
 * Freeze the question.
 *
 * Validated through the schema at construction rather than at publication, so a
 * malformed spec fails before an agent is invoked and before anything is
 * published against it.
 */
export function buildTrialSpec(inputs: TrialSpecInputs): TrialSpec {
  const document = {
    schemaVersion: TRIAL_SPEC_SCHEMA_VERSION,
    nonce: inputs.nonce,
    chain: { chainId: inputs.chainId, snapshotBlock: inputs.snapshotBlock.toString(10) },
    agent: {
      identityRegistry: inputs.agentIdentity.identityRegistry,
      agentId: inputs.agentIdentity.agentId,
      registrationUriHash: inputs.registrationUriHash,
      agentVersionHash: inputs.agentVersionHash,
      endpointHash: inputs.endpointHash,
      skillHashes: [...inputs.skillHashes],
    },
    category: "HEALTH_FACTOR",
    task: {
      protocolId: "venus",
      actionType: "restore-health-factor",
      resourceId: "vUSDT",
      inputHash: inputs.taskInputHash,
      parametersHash: inputs.taskParametersHash,
    },
    authority: inputs.testedAuthority,
    scenario: {
      scenarioId: inputs.scenarioId,
      scenarioVersion: inputs.scenarioVersion,
      scenarioHash: inputs.scenarioHash,
    },
    evaluator: {
      evaluatorId: "venus-health-factor-evaluator",
      version: "1.0.0",
      codeHash: inputs.evaluatorCodeHash,
      referenceModelHash: inputs.referenceModelHash,
    },
    timing: {
      createdAt: inputs.createdAt,
      expiresAt: inputs.createdAt + 3_600,
      evidenceMaxAge: EVIDENCE_MAX_AGE_SECONDS,
    },
  };

  const parsed = TrialSpecSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `the Phase 7 trial spec is not a valid TrialSpec: ${JSON.stringify(parsed.error.issues.slice(0, 5))}`,
    );
  }
  return parsed.data;
}

/**
 * Load the audited safety profile for the one call the mandate permits.
 *
 * Read from the committed artifact rather than recomputed, because the profile
 * is the output of an analysis run at a named block and re-deriving it here
 * would silently substitute today's opinion for the one the authority was built
 * against. The compiler then checks the deployed code against it.
 */
export function loadVenusProfile(chainId: number): ProtocolSafetyProfile {
  const path = fileURLToPath(
    new URL(
      `../../../../artifacts/protocol-profiles/venus/${chainId}-${REPAY_BORROW_SELECTOR}.json`,
      import.meta.url,
    ),
  );
  const parsed = ProtocolSafetyProfileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `the Venus safety profile for chain ${chainId} is not valid: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`,
    );
  }
  return parsed.data;
}

/**
 * Golden fixtures shared by every consumer of the canonical types.
 *
 * The same documents are hashed by the API, the trial runner, the verifier and
 * the Solidity tests. Keeping one definition here is what makes "the fixture
 * hashes identically everywhere" a testable statement rather than an aspiration;
 * `scripts/emit-golden-fixtures.ts` writes them out for the Foundry suite to
 * read.
 *
 * Addresses are real BSC testnet deployments where a real one exists, so the
 * fixtures stay useful as documentation of the intended shape.
 */
import type { AuthorityIR } from "./schemas/authority-ir.js";
import type { TrialReceipt } from "./schemas/trial-receipt.js";
import type { TrialSpec } from "./schemas/trial-spec.js";
import { closedDownstreamPolicy, emptyDurableEffects, UNBOUND_WALLET } from "./schemas/authority-ir.js";
import { AUTHORITY_IR_SCHEMA_VERSION } from "./schemas/authority-ir.js";
import { TRIAL_SPEC_SCHEMA_VERSION } from "./schemas/trial-spec.js";
import { TRIAL_RECEIPT_SCHEMA_VERSION } from "./schemas/trial-receipt.js";

const ZERO_32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

function hashPlaceholder(nibble: string): `0x${string}` {
  return `0x${nibble.repeat(64)}` as `0x${string}`;
}

/**
 * A tested authority: one lending repayment, one token, a rolling daily cap.
 *
 * Deliberately the narrowest useful shape. `wallet` is the zero address because
 * a tested envelope belongs to an agent version, not to any particular user.
 */
export const GOLDEN_TESTED_AUTHORITY: AuthorityIR = {
  schemaVersion: AUTHORITY_IR_SCHEMA_VERSION,
  chainId: 97,
  subject: {
    wallet: UNBOUND_WALLET,
    agentIdentity: {
      identityRegistry: "0x1111111111111111111111111111111111111111",
      agentId: "18433",
    },
    agentVersionHash: hashPlaceholder("a"),
  },
  calls: [
    {
      target: "0x2222222222222222222222222222222222222222",
      selector: "0x0e752702",
      signature: "repayBorrow(uint256)",
      protocolId: "venus",
      protocolVersionHash: hashPlaceholder("b"),
    },
  ],
  spend: [
    {
      token: "0x3333333333333333333333333333333333333333",
      limit: "50000000000000000000",
      period: "day",
    },
  ],
  durableEffects: emptyDurableEffects(),
  downstreamPolicy: closedDownstreamPolicy(),
  lifetime: { maxDurationSeconds: 604_800 },
};

/**
 * A granted authority derived from the tested one: same call, half the spend,
 * a day instead of a week. Every difference tightens, so the subset relation
 * holds.
 */
export const GOLDEN_GRANTED_AUTHORITY: AuthorityIR = {
  ...GOLDEN_TESTED_AUTHORITY,
  subject: {
    ...GOLDEN_TESTED_AUTHORITY.subject,
    wallet: "0x4444444444444444444444444444444444444444",
  },
  spend: [
    {
      token: "0x3333333333333333333333333333333333333333",
      limit: "25000000000000000000",
      period: "day",
    },
  ],
  lifetime: { maxDurationSeconds: 86_400, notAfter: 1_800_000_000 },
};

export const GOLDEN_TRIAL_SPEC: TrialSpec = {
  schemaVersion: TRIAL_SPEC_SCHEMA_VERSION,
  nonce: hashPlaceholder("1"),
  chain: {
    chainId: 97,
    snapshotBlock: "40000000",
  },
  agent: {
    identityRegistry: "0x1111111111111111111111111111111111111111",
    agentId: "18433",
    registrationUriHash: hashPlaceholder("2"),
    agentVersionHash: hashPlaceholder("a"),
    endpointHash: hashPlaceholder("3"),
    skillHashes: [hashPlaceholder("4")],
  },
  category: "HEALTH_FACTOR",
  task: {
    protocolId: "venus",
    actionType: "restore-health-factor",
    resourceId: "vUSDT",
    inputHash: hashPlaceholder("5"),
    parametersHash: hashPlaceholder("6"),
  },
  authority: GOLDEN_TESTED_AUTHORITY,
  scenario: {
    scenarioId: "venus-hf-drawdown",
    scenarioVersion: "1.0.0",
    scenarioHash: hashPlaceholder("7"),
    seedCommitment: hashPlaceholder("8"),
  },
  evaluator: {
    evaluatorId: "health-factor-evaluator",
    version: "1.0.0",
    codeHash: hashPlaceholder("9"),
    referenceModelHash: hashPlaceholder("c"),
  },
  timing: {
    createdAt: 1_790_000_000,
    expiresAt: 1_790_003_600,
    evidenceMaxAge: 604_800,
  },
};

export const GOLDEN_TRIAL_RECEIPT: TrialReceipt = {
  schemaVersion: TRIAL_RECEIPT_SCHEMA_VERSION,
  chainId: 97,
  identityRegistry: "0x1111111111111111111111111111111111111111",
  agentId: "18433",
  agentVersionHash: hashPlaceholder("a"),
  trialSpecHash: hashPlaceholder("d"),
  testedAuthorityHash: hashPlaceholder("e"),
  scenarioHash: hashPlaceholder("7"),
  evaluatorHash: hashPlaceholder("9"),
  referenceModelHash: hashPlaceholder("c"),
  result: "PASS",
  evidenceHash: hashPlaceholder("f"),
  evidenceURI: "r2://mandate-evidence/golden/trial-0001.json",
  snapshotBlock: "40000000",
  createdAt: 1_790_000_000,
  freshUntil: 1_790_604_800,
  publisher: "0x5555555555555555555555555555555555555555",
};

export const ZERO_BYTES32 = ZERO_32;

/**
 * The write lane.
 *
 * Every function below changes chain state or reads state that only exists
 * because something above it did. Nothing here runs until `runPreflight`
 * returned no blockers and the operator set `PROOF_CONFIRM=1`, because granting
 * a session spends real tBNB and cannot be undone.
 *
 * Two keys act, and which one acts where is the point of the whole sequence.
 * The OWNER signs the receipt publication, the standing approval, the grant, the
 * revocation and the registry records: everything an account holder does. The
 * AGENT signs the executions and only the executions, through the session the
 * owner granted it. The owner never signs an intent the agent should have
 * signed, and the agent is never handed the wallet's admin authority, so the
 * refusals below are refusals of a stranger's attempts rather than of one
 * party's own instruction.
 *
 * The order is the mandate lifecycle and is not rearrangeable. The receipt is
 * published before any authority is granted, so a mandate can never exist
 * without a public commitment to the evidence behind it. The standing allowance
 * is created before the session, because a session that could create its own
 * would hold `approve` and its real authority would be "move this token
 * anywhere" rather than "reduce my own debt". Revocation comes before cleanup,
 * so the allowance is cleared while nothing can still spend it.
 *
 * Each step records what it observed even when it fails. A step that throws
 * leaves its status where it was, and the manifest reports that, rather than the
 * run inventing a terminal result for work it did not finish.
 */
import { createClient as createAltanaClient, BNB_TESTNET, signerFromPrivateKey } from "@altananetwork/sdk";
import type { GrantSessionResult } from "@altananetwork/sdk";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseEventLogs,
} from "viem";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";
import {
  canAccountExecute,
  decodeRevert,
  diffRequestedVsEnforced,
  hasCriticalDiscrepancy,
  isKeyValidInKeyStore,
  readEnforcedAuthority,
  sessionKeyIdentity,
  startOfSpendPeriod,
  type AuthorityDiscrepancy,
  type DecodedRevert,
  type EnforcedAuthority,
} from "@mandate/altana";
import { authorityHash } from "@mandate/authority-ir";
import { compileAuthority, permissionsFor, profileKey } from "@mandate/authority-compiler";
import { deriveMandateId, deriveReceiptId } from "@mandate/domain";
import type { AuthorityIR, ProtocolSafetyProfile } from "@mandate/domain";
import { executeExpectingOutcome, isAccountRejection, rejectionNameFrom } from "./expect-rejection.js";
import {
  attributeFromAccountView,
  judgeRejection,
  type AccountViewAtAttempt,
  type RejectionMechanism,
} from "./attribution.js";
import type { Phase7Config } from "./config.js";
import type { RoleAddresses } from "./roles.js";
import type {
  ExecutionRecord,
  MandateSummary,
  ReceiptSummary,
  RejectionAttribution,
} from "./manifest.js";
import {
  AT_CAP_REPAY_RAW,
  BREACH_REPAY_RAW,
  BORROW_SELECTOR,
  DAILY_SPEND_CAP_RAW,
  MANDATE_LIFETIME_SECONDS,
  REPAY_BORROW_SELECTOR,
  buildGrantedAuthority,
  type AllowancePlan,
} from "./plan.js";
import { extractRevertData, recoverRevertData, selectorOfRevert } from "./revert-data.js";
import { bucketHeld, DAY_PERIOD_ENUM } from "./spend-bucket.js";
import type { Phase7Journal } from "./steps.js";

const REGISTRY_WRITE_ABI = [
  {
    name: "publishReceipt",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "receipt",
        type: "tuple",
        components: [
          { name: "identityRegistry", type: "address" },
          { name: "agentId", type: "uint256" },
          { name: "agentVersionHash", type: "bytes32" },
          { name: "trialSpecHash", type: "bytes32" },
          { name: "testedAuthorityHash", type: "bytes32" },
          { name: "scenarioHash", type: "bytes32" },
          { name: "evaluatorHash", type: "bytes32" },
          { name: "referenceModelHash", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "snapshotBlock", type: "uint64" },
          { name: "createdAt", type: "uint64" },
          { name: "freshUntil", type: "uint64" },
          { name: "passed", type: "bool" },
        ],
      },
      { name: "evidenceURI", type: "string" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "recordActivation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "trialReceiptId", type: "bytes32" },
      { name: "wallet", type: "address" },
      { name: "sessionKeyHash", type: "bytes32" },
      { name: "grantedAuthorityHash", type: "bytes32" },
      { name: "sequence", type: "uint32" },
      { name: "disclosureURI", type: "string" },
      { name: "validFrom", type: "uint64" },
      { name: "validUntil", type: "uint64" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "recordRevocation",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "mandateId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "event",
    name: "ReceiptPublished",
    inputs: [
      { name: "receiptId", type: "bytes32", indexed: true },
      { name: "publisher", type: "address", indexed: true },
      { name: "identityRegistry", type: "address", indexed: true },
      { name: "agentId", type: "uint256", indexed: false },
      { name: "agentVersionHash", type: "bytes32", indexed: false },
      { name: "trialSpecHash", type: "bytes32", indexed: false },
      { name: "testedAuthorityHash", type: "bytes32", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: false },
      { name: "passed", type: "bool", indexed: false },
      { name: "evidenceURI", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MandateActivated",
    inputs: [
      { name: "mandateId", type: "bytes32", indexed: true },
      { name: "trialReceiptId", type: "bytes32", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "sessionKeyHash", type: "bytes32", indexed: false },
      { name: "grantedAuthorityHash", type: "bytes32", indexed: false },
      { name: "attestedBy", type: "address", indexed: false },
      { name: "disclosureURI", type: "string", indexed: false },
      { name: "validFrom", type: "uint64", indexed: false },
      { name: "validUntil", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MandateRevoked",
    inputs: [
      { name: "mandateId", type: "bytes32", indexed: true },
      { name: "wallet", type: "address", indexed: true },
      { name: "revokedAt", type: "uint64", indexed: false },
    ],
  },
] as const;

const ERC20_WRITE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const VTOKEN_ABI = [
  {
    name: "repayBorrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "repayAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "borrow",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "borrowAmount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "borrowBalanceStored",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface ReceiptFields {
  identityRegistry: Address;
  agentId: bigint;
  agentVersionHash: Hex;
  trialSpecHash: Hex;
  testedAuthorityHash: Hex;
  scenarioHash: Hex;
  evaluatorHash: Hex;
  referenceModelHash: Hex;
  evidenceHash: Hex;
  snapshotBlock: bigint;
  createdAt: bigint;
  freshUntil: bigint;
  passed: boolean;
}

export interface SequenceContext {
  journal: Phase7Journal;
  config: Phase7Config;
  client: PublicClient;
  registry: Address;
  wallet: Address;
  /** Who is who. Addresses only; the keys arrive separately and stay separate. */
  roles: RoleAddresses;
  /**
   * This run's session key, derived from the agent's identity key by
   * `resolveRoles`. It reaches the sequence already made, because a session key
   * minted here would be a key the owner's process chose and the separation
   * would be nominal.
   */
  sessionPrivateKey: Hex;
  profile: ProtocolSafetyProfile;
  testedAuthority: AuthorityIR;
  allowance: AllowancePlan;
  receiptFields: ReceiptFields;
  evidenceURI: string;
  /**
   * Write the disclosure document and return where a verifier can fetch it.
   *
   * A callback rather than a URI passed in, because the disclosure lists the
   * transactions the sequence produced and therefore cannot exist until they
   * have. Publishing an activation that points at a document written before the
   * executions would commit to a disclosure that omits them.
   */
  writeDisclosure: (input: DisclosureInput) => { uri: string; relativePath: string };
  /** The bucket the run started in. The breach step refuses to run in a different one. */
  bucketStart: bigint;
  now: number;
}

export interface DisclosureInput {
  grantedAuthority: AuthorityIR;
  wallet: Address;
  keyHash: Hex;
  grantTxHash?: Hex;
  executions: readonly ExecutionRecord[];
}

export interface SequenceResult {
  executions: ExecutionRecord[];
  receipt?: ReceiptSummary;
  mandate?: MandateSummary;
  grantedAuthority?: AuthorityIR;
  discrepancies: AuthorityDiscrepancy[];
  /** Set when the sequence stopped early. The journal already says where. */
  haltReason?: string;
}

function repayCalldata(amount: bigint): Hex {
  return encodeFunctionData({ abi: VTOKEN_ABI, functionName: "repayBorrow", args: [amount] });
}

/**
 * Ask the account whether it would permit a call, tolerating a revert.
 *
 * `canExecute` returns false for a call outside the permission set, but once the
 * key itself is gone it reverts `KeyDoesNotExist` instead. That revert is the
 * answer, not an error: an account that will not even evaluate the call is
 * certainly not going to authorize it. Letting it escape would take down a
 * funded run at its last read, which is what happened before this existed.
 *
 * The decoded error is carried back so the manifest can record what the account
 * raised rather than only that the probe failed.
 */
async function probeCanExecute(
  client: PublicClient,
  params: { wallet: Address; keyHash: Hex; target: Address; data: Hex },
): Promise<{ permitted: boolean; revert?: DecodedRevert }> {
  try {
    return { permitted: await canAccountExecute(client, params) };
  } catch (error) {
    const data = extractRevertData(error);
    return { permitted: false, ...(data === undefined ? {} : { revert: decodeRevert(data) }) };
  }
}

/**
 * Freeze what the account said about a refusal onto the execution record.
 *
 * The mechanism is the one the account's own storage implies, computed from
 * state read immediately before the attempt. The validator error is taken from
 * whichever of the two independent routes produced one — decoded revert bytes
 * first, because those are the direct artifact, then the custom error viem
 * recovered from the SDK's throw. Neither is substituted for the other and
 * neither is defaulted, so a refusal that yielded no name carries none and the
 * disclosure leaves it out.
 */
function attributionOf(params: {
  view: AccountViewAtAttempt;
  mechanism: RejectionMechanism;
  decodedName?: string | undefined;
  thrownName?: string | undefined;
}): RejectionAttribution {
  const validatorError = isAccountRejection(params.decodedName)
    ? params.decodedName
    : isAccountRejection(params.thrownName)
      ? params.thrownName
      : undefined;

  return {
    ...(validatorError === undefined ? {} : { validatorError }),
    mechanism: params.mechanism,
    accountState: {
      callPermitted: params.view.callPermitted,
      keyRegistered: params.view.keyRegistered,
      spendCapRaw: params.view.spendLimitRaw.toString(10),
      spentInBucketRaw: params.view.spentInBucketRaw.toString(10),
      allowanceAtAttemptRaw: params.view.allowanceRaw.toString(10),
    },
  };
}

/**
 * Run the whole write lane.
 *
 * Returns rather than throws on a step failure so the caller can still write a
 * manifest describing exactly how far it got. An exception escaping from here
 * would take the record of the writes with it.
 */
export async function runWriteSequence(context: SequenceContext): Promise<SequenceResult> {
  const { journal, config, client, wallet } = context;
  const executions: ExecutionRecord[] = [];
  const result: SequenceResult = { executions, discrepancies: [] };

  if (config.ownerPrivateKey === undefined) {
    throw new Error("runWriteSequence reached without an owner key; preflight should have blocked");
  }

  const ownerAccount = privateKeyToAccount(config.ownerPrivateKey);
  const walletClient: WalletClient = createWalletClient({
    account: ownerAccount,
    chain: bscTestnet,
    transport: http(config.rpcUrl),
  });
  const altana = createAltanaClient({ chains: [BNB_TESTNET] });
  const ownerSigner = signerFromPrivateKey(config.ownerPrivateKey);

  /**
   * The agent's key for this run.
   *
   * Built from material the owner's key cannot produce. Everything signed with
   * it below is signed as the agent, and the owner's signer is never passed to
   * `execute`.
   */
  const sessionSigner = signerFromPrivateKey(context.sessionPrivateKey);

  const sendAsOwner = async (to: Address, data: Hex): Promise<Hex> => {
    const hash = await walletClient.sendTransaction({
      account: ownerAccount,
      chain: bscTestnet,
      to,
      data,
    });
    await client.waitForTransactionReceipt({ hash });
    return hash;
  };

  // ---- publish the trial receipt -------------------------------------------
  journal.begin("publish-receipt");
  const receiptId = deriveReceiptId({
    chainId: config.chainId,
    publisher: ownerAccount.address.toLowerCase() as Address,
    ...context.receiptFields,
    evidenceURI: context.evidenceURI,
  });

  const publishTxHash = await sendAsOwner(
    context.registry,
    encodeFunctionData({
      abi: REGISTRY_WRITE_ABI,
      functionName: "publishReceipt",
      args: [context.receiptFields, context.evidenceURI],
    }),
  );

  const publishReceiptLog = parseEventLogs({
    abi: REGISTRY_WRITE_ABI,
    eventName: "ReceiptPublished",
    logs: (await client.getTransactionReceipt({ hash: publishTxHash })).logs,
  })[0];

  // Re-derived in TypeScript and compared with what Solidity emitted. If the two
  // ever disagree, every id MANDATE has ever published names something else.
  if (publishReceiptLog === undefined || publishReceiptLog.args.receiptId !== receiptId) {
    journal.fail(
      "publish-receipt",
      `the registry emitted ${publishReceiptLog?.args.receiptId ?? "no receipt id"}, not the re-derived ${receiptId}`,
      [{ label: "publishTxHash", value: publishTxHash }],
    );
    result.haltReason = "receipt id derivation disagrees with the registry";
    return result;
  }

  result.receipt = {
    receiptId,
    publishTxHash,
    evidenceURI: context.evidenceURI,
    publisher: ownerAccount.address.toLowerCase(),
  };
  journal.pass("publish-receipt", `receipt ${receiptId} published`, [
    { label: "receiptId", value: receiptId },
    { label: "publishTxHash", value: publishTxHash },
    { label: "registry", value: context.registry },
    { label: "evidenceURI", value: context.evidenceURI },
  ]);

  // ---- compile the granted authority ---------------------------------------
  journal.begin("compile-authority");
  const expiry = context.now + MANDATE_LIFETIME_SECONDS;
  const grantedAuthority = buildGrantedAuthority({
    chainId: config.chainId,
    vToken: config.venus.vToken,
    underlying: config.venus.underlying,
    protocolVersionHash: context.profile.implementationCodeHash ?? context.profile.runtimeCodeHash,
    agentIdentity: context.testedAuthority.subject.agentIdentity,
    agentVersionHash: context.testedAuthority.subject.agentVersionHash,
    wallet,
    expiry,
    standingAllowance: context.allowance.standingAllowance,
  });
  result.grantedAuthority = grantedAuthority;

  const compiled = compileAuthority({
    tested: context.testedAuthority,
    granted: grantedAuthority,
    profiles: new Map<string, ProtocolSafetyProfile>([
      [profileKey(config.venus.vToken, REPAY_BORROW_SELECTOR), context.profile],
    ]),
    evidenceIsCurrent: true,
    expiry,
    now: context.now,
    sessionPublicKey: sessionSigner.publicKey,
  });

  if (!compiled.ok) {
    journal.fail(
      "compile-authority",
      compiled.errors.map((error) => `${error.code}: ${error.message}`).join("; "),
    );
    result.haltReason = "the granted authority did not compile";
    return result;
  }

  journal.pass(
    "compile-authority",
    `compiled to ${grantedAuthority.calls.length} call rule(s) and ${grantedAuthority.spend.length} spend cap(s)`,
    [
      { label: "grantedAuthorityHash", value: authorityHash(grantedAuthority) },
      { label: "testedAuthorityHash", value: authorityHash(context.testedAuthority) },
      { label: "permissionsHash", value: compiled.mandate.enforcement.permissionsHash },
      ...compiled.warnings.map((warning) => ({ label: warning.code, value: warning.message })),
    ],
  );

  // ---- standing allowance --------------------------------------------------
  journal.begin("standing-approval");
  const approvalTxHash = await sendAsOwner(
    config.venus.underlying,
    encodeFunctionData({
      abi: ERC20_WRITE_ABI,
      functionName: "approve",
      args: [config.venus.vToken, context.allowance.standingAllowance],
    }),
  );
  const approvedAllowance = await client.readContract({
    address: config.venus.underlying,
    abi: ERC20_WRITE_ABI,
    functionName: "allowance",
    args: [wallet, config.venus.vToken],
  });
  executions.push({
    step: "standing-approval",
    label: "admin-path approve sized to the mandate lifetime",
    target: config.venus.underlying,
    selector: "0x095ea7b3",
    amountRaw: context.allowance.standingAllowance.toString(10),
    txHash: approvalTxHash,
    status: "SUCCESS",
  });

  if (approvedAllowance < context.allowance.standingAllowance) {
    journal.fail(
      "standing-approval",
      `the allowance reads ${approvedAllowance}, below the ${context.allowance.standingAllowance} that was approved`,
      [{ label: "approvalTxHash", value: approvalTxHash }],
    );
    result.haltReason = "the standing allowance was not created";
    return result;
  }
  journal.pass("standing-approval", `allowance ${approvedAllowance} raw`, [
    { label: "approvalTxHash", value: approvalTxHash },
    { label: "allowanceRaw", value: approvedAllowance.toString(10) },
  ]);

  // ---- grant the session ---------------------------------------------------
  journal.begin("grant-session");

  // The relay rejects a quote for an address it has never seen with "quotes for
  // unknown accounts are not accepted". `createWallet` registers the signer's
  // address as a smart account counterfactually — no transaction, no new
  // address, because the account is an EIP-7702 delegation of this same EOA.
  // Skipping it makes a funded, position-holding wallet look like a stranger.
  await altana.createWallet({ signer: ownerSigner });

  const permissions = permissionsFor(grantedAuthority);
  const session: GrantSessionResult = await altana.grantSession({
    wallet: { address: wallet },
    signer: ownerSigner,
    chainId: config.chainId,
    permissions,
    expiry,
    sessionSigner,
  });

  const identity = sessionKeyIdentity(session.publicKey);
  const grantEvidence = [
    ...(session.transactionHash === undefined
      ? []
      : [{ label: "grantTxHash", value: session.transactionHash }]),
    { label: "grantedBy", value: `owner ${context.roles.owner}` },
    { label: "grantedTo", value: `agent ${context.roles.agent}` },
    { label: "sessionPublicKey", value: session.publicKey },
    { label: "sessionKeyAddress", value: identity.signerAddress.toLowerCase() },
    { label: "sessionKeyHash", value: identity.keyHash },
    { label: "sessionKeyId", value: identity.keyId },
    { label: "expiry", value: String(expiry) },
  ];

  // The account now enforces against a key. Whether that key is the one the
  // agent designated is the difference between an arm's-length grant and a
  // wallet talking to itself, so it is checked rather than assumed.
  if (identity.signerAddress.toLowerCase() !== context.roles.sessionKey) {
    journal.fail(
      "grant-session",
      `the session was granted to ${identity.signerAddress.toLowerCase()}, not to the key the agent designated`,
      grantEvidence,
    );
    result.haltReason = "the granted session key is not the one the agent designated";
    return result;
  }

  journal.pass(
    "grant-session",
    `the owner granted session key ${identity.signerAddress} to agent ${context.roles.agent} until ${expiry}`,
    grantEvidence,
  );

  // ---- read what the account actually enforces -----------------------------
  journal.begin("read-enforced-authority");
  const enforced: EnforcedAuthority = await readEnforcedAuthority(client, {
    wallet,
    keyHash: identity.keyHash,
  });
  if (!enforced.registered) {
    journal.fail("read-enforced-authority", "the account holds no key with this hash after the grant");
    result.haltReason = "the granted key is not on the account";
    return result;
  }
  // The window the activation commits to is read back from chain rather than
  // taken from the object that was sent to the relay. `validUntil` is the
  // expiry the account itself holds for this key, and `validFrom` is the
  // timestamp of the block the grant landed in. A window assembled from the
  // request would describe the grant MANDATE asked for, not the one that
  // exists, which is the distinction this whole step is here to draw.
  //
  // The relay does not always return a transaction hash, and one it returns
  // could in principle not be retrievable yet. Either way the account is
  // already holding the key, so the block it was first observed at is a real
  // upper bound on when the session started and is used as the fallback.
  const grantBlockNumber =
    session.transactionHash === undefined
      ? enforced.observedAtBlock
      : await client
          .getTransactionReceipt({ hash: session.transactionHash })
          .then((receipt) => receipt.blockNumber)
          .catch(() => enforced.observedAtBlock);
  const validFrom = (await client.getBlock({ blockNumber: grantBlockNumber })).timestamp;
  const validUntil = BigInt(enforced.expiry);

  journal.pass(
    "read-enforced-authority",
    `${enforced.callRules.length} enforced call rule(s), ${enforced.spendLimits.length} spend limit(s), ${enforced.walletWideRules.length} wallet-wide rule(s)`,
    [
      { label: "observedAtBlock", value: enforced.observedAtBlock.toString(10) },
      { label: "validFrom", value: validFrom.toString(10) },
      { label: "validUntil", value: validUntil.toString(10) },
      ...enforced.callRules.map((rule) => ({ label: "enforcedCall", value: `${rule.target} ${rule.selector}` })),
      ...enforced.spendLimits.map((limit) => ({
        label: "enforcedSpend",
        value: `${limit.token} ${limit.period} limit ${limit.limit} spent ${limit.currentSpent}`,
      })),
    ],
  );

  // ---- disclose every difference -------------------------------------------
  journal.begin("compare-requested-enforced");
  const discrepancies = diffRequestedVsEnforced(permissions, enforced, {
    orchestrator: config.altana.orchestrator,
    requestedExpiry: expiry,
  });
  result.discrepancies = discrepancies;
  const evidence = discrepancies.map((entry) => ({
    label: `${entry.severity} ${entry.code}`,
    value: entry.message,
  }));

  if (hasCriticalDiscrepancy(discrepancies)) {
    // The displayed boundary is not the real one. Continuing would execute
    // inside a scope the proof page would describe wrongly.
    journal.fail(
      "compare-requested-enforced",
      `${discrepancies.filter((entry) => entry.severity === "CRITICAL").length} critical discrepancy between requested and enforced authority`,
      evidence,
    );
    result.haltReason = "enforced authority differs critically from what was requested";
    return result;
  }
  journal.pass(
    "compare-requested-enforced",
    `${discrepancies.length} disclosed difference(s), none critical`,
    evidence,
  );

  // ---- the permitted call --------------------------------------------------
  journal.begin("execute-repay");
  const debtBefore = await client.readContract({
    address: config.venus.vToken,
    abi: VTOKEN_ABI,
    functionName: "borrowBalanceStored",
    args: [wallet],
  });
  const balanceBefore = await client.readContract({
    address: config.venus.underlying,
    abi: ERC20_WRITE_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });

  const repay = await altana.execute({
    session,
    chainId: config.chainId,
    calls: [{ to: config.venus.vToken, data: repayCalldata(AT_CAP_REPAY_RAW) }],
  });

  const repayRecord: ExecutionRecord = {
    step: "execute-repay",
    label: `repay ${AT_CAP_REPAY_RAW} raw USDT, inside the granted scope`,
    target: config.venus.vToken,
    selector: REPAY_BORROW_SELECTOR,
    amountRaw: AT_CAP_REPAY_RAW.toString(10),
    status: repay.status === "CONFIRMED" ? "SUCCESS" : "REVERTED",
    ...(repay.transactionHash === undefined ? {} : { txHash: repay.transactionHash }),
  };
  executions.push(repayRecord);

  if (repay.status !== "CONFIRMED") {
    journal.fail("execute-repay", `the permitted call did not confirm: ${repay.status}`, [
      { label: "callsId", value: repay.callsId },
    ]);
    result.haltReason = "the permitted call failed";
    return result;
  }
  journal.pass(
    "execute-repay",
    `the agent repaid ${AT_CAP_REPAY_RAW} raw USDT under the session the owner granted it`,
    [
      { label: "callsId", value: repay.callsId },
      ...(repay.transactionHash === undefined ? [] : [{ label: "txHash", value: repay.transactionHash }]),
      // Named because this is the claim: the owner signed nothing here.
      { label: "signedBy", value: `agent session key ${context.roles.sessionKey}` },
      { label: "agent", value: context.roles.agent },
    ],
  );

  // ---- did the position move by exactly what was spent? --------------------
  journal.begin("venus-post-state");
  const debtAfter = await client.readContract({
    address: config.venus.vToken,
    abi: VTOKEN_ABI,
    functionName: "borrowBalanceStored",
    args: [wallet],
  });
  const balanceAfter = await client.readContract({
    address: config.venus.underlying,
    abi: ERC20_WRITE_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
  const spent = balanceBefore - balanceAfter;
  const enforcedAfterRepay = await readEnforcedAuthority(client, { wallet, keyHash: identity.keyHash });
  const usdtLimit = enforcedAfterRepay.spendLimits.find(
    (limit) => limit.token === config.venus.underlying && limit.period === "day",
  );

  const postStateEvidence = [
    { label: "debtBeforeRaw", value: debtBefore.toString(10) },
    { label: "debtAfterRaw", value: debtAfter.toString(10) },
    { label: "underlyingSpentRaw", value: spent.toString(10) },
    { label: "accountCurrentSpentRaw", value: (usdtLimit?.currentSpent ?? 0n).toString(10) },
  ];

  if (spent !== AT_CAP_REPAY_RAW || debtAfter >= debtBefore) {
    journal.fail(
      "venus-post-state",
      `expected ${AT_CAP_REPAY_RAW} raw to leave the wallet and the debt to fall; observed ${spent} raw and debt ${debtBefore} -> ${debtAfter}`,
      postStateEvidence,
    );
    result.haltReason = "the repayment did not move the position as expected";
    return result;
  }
  journal.pass(
    "venus-post-state",
    `debt fell by ${debtBefore - debtAfter} raw, ${spent} raw left the wallet, the account counted ${usdtLimit?.currentSpent ?? 0n} against the bucket`,
    postStateEvidence,
  );

  // ---- the same-bucket cap breach ------------------------------------------
  journal.begin("cap-breach-attempt");
  const bucketNow = await startOfSpendPeriod(client, {
    wallet: config.altana.accountImplementation,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    periodEnum: DAY_PERIOD_ENUM,
  });

  if (!bucketHeld(bucketNow, context.bucketStart)) {
    // The bucket rolled over mid-run. `spent` has reset, so the attempt would
    // succeed for a reason that has nothing to do with authority.
    journal.block(
      "cap-breach-attempt",
      `the UTC spend bucket moved from ${context.bucketStart} to ${bucketNow} during the run, so a breach attempt would prove nothing`,
    );
    result.haltReason = "the UTC spend bucket rolled over mid-run";
    return result;
  }

  const breachData = repayCalldata(BREACH_REPAY_RAW);
  const view: AccountViewAtAttempt = {
    callPermitted: await canAccountExecute(client, {
      wallet,
      keyHash: identity.keyHash,
      target: config.venus.vToken,
      data: breachData,
    }),
    keyRegistered: enforcedAfterRepay.registered,
    spendLimitRaw: usdtLimit?.limit ?? 0n,
    spentInBucketRaw: usdtLimit?.currentSpent ?? 0n,
    allowanceRaw: await client.readContract({
      address: config.venus.underlying,
      abi: ERC20_WRITE_ABI,
      functionName: "allowance",
      args: [wallet, config.venus.vToken],
    }),
    balanceRaw: balanceAfter,
    amountRaw: BREACH_REPAY_RAW,
  };

  const breach = await executeExpectingOutcome("REJECTION", () =>
    altana.execute({
      session,
      chainId: config.chainId,
      calls: [{ to: config.venus.vToken, data: breachData }],
    }),
  );

  const breachRecord: ExecutionRecord = {
    step: "cap-breach-attempt",
    label: `repay ${BREACH_REPAY_RAW} raw USDT, taking the bucket past its ${DAILY_SPEND_CAP_RAW} cap`,
    target: config.venus.vToken,
    selector: REPAY_BORROW_SELECTOR,
    amountRaw: BREACH_REPAY_RAW.toString(10),
    status: breach.outcome === "SUCCESS" ? "SUCCESS" : "REVERTED",
    ...(breach.transactionHash === undefined ? {} : { txHash: breach.transactionHash }),
  };
  executions.push(breachRecord);

  if (breach.outcome === "SUCCESS") {
    journal.fail(
      "cap-breach-attempt",
      "the breach succeeded; the cumulative bucket cap was not enforced",
      [{ label: "callsId", value: breach.callsId ?? "none" }],
    );
    result.haltReason = "the spend cap did not reject the breach";
    return result;
  }
  journal.pass("cap-breach-attempt", `the agent's breach was rejected (${breach.status})`, [
    { label: "callsId", value: breach.callsId ?? "none" },
    { label: "signedBy", value: `agent session key ${context.roles.sessionKey}` },
    // Recovered straight from the throw, so this holds even when the relay
    // never surfaces raw revert bytes for a receipt lookup.
    { label: "rejectionName", value: breach.rejectionName ?? "unrecovered" },
    { label: "allowanceAtAttemptRaw", value: view.allowanceRaw.toString(10) },
    { label: "spentInBucketRaw", value: view.spentInBucketRaw.toString(10) },
    { label: "capRaw", value: view.spendLimitRaw.toString(10) },
  ]);

  // ---- and prove it was the spend cap, not the allowance -------------------
  journal.begin("cap-breach-is-spend-limit");
  const breachRevert =
    breach.transactionHash === undefined
      ? { source: "NONE" as const }
      : await recoverRevertData(client, breach.transactionHash);
  const breachVerdict = judgeRejection({
    expected: "SPEND_CAP",
    view,
    ...(breachRevert.data === undefined ? {} : { revertData: breachRevert.data }),
    ...(breach.rejectionName === undefined ? {} : { thrownRejectionName: breach.rejectionName }),
  });

  breachRecord.revertSelector = selectorOfRevert(breachRevert.data) ?? "";
  breachRecord.revertName = breachVerdict.decoded?.name ?? "";
  breachRecord.revertClass = breachVerdict.decoded?.class ?? "";
  breachRecord.attribution = attributionOf({
    view,
    mechanism: breachVerdict.fromAccountView.mechanism,
    decodedName: breachVerdict.decoded?.name,
    thrownName: breach.rejectionName,
  });

  const breachEvidence = [
    { label: "expectedMechanism", value: "SPEND_CAP" },
    { label: "revertSelector", value: selectorOfRevert(breachRevert.data) ?? "unrecovered" },
    { label: "revertSource", value: breachRevert.source },
    { label: "accountViewMechanism", value: breachVerdict.fromAccountView.mechanism },
    { label: "allowanceRuledOut", value: String(breachVerdict.fromAccountView.allowanceRuledOut) },
    { label: "allowanceAtAttemptRaw", value: view.allowanceRaw.toString(10) },
  ];

  if (breachVerdict.proven) {
    journal.pass("cap-breach-is-spend-limit", breachVerdict.observed, breachEvidence);
  } else if (breachRevert.data === undefined) {
    journal.block("cap-breach-is-spend-limit", breachVerdict.observed, breachEvidence);
  } else {
    journal.fail("cap-breach-is-spend-limit", breachVerdict.observed, breachEvidence);
  }

  // ---- out-of-scope target and selector ------------------------------------
  journal.begin("wrong-target-attempt");
  const strayMarket: Address = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7";
  const wrongTargetData = repayCalldata(1n);
  const wrongSelectorData = encodeFunctionData({
    abi: VTOKEN_ABI,
    functionName: "borrow",
    args: [1n],
  });

  const attempts = [
    {
      step: "wrong-target-attempt",
      label: "the granted selector on a vToken outside the permission set",
      target: strayMarket,
      selector: REPAY_BORROW_SELECTOR,
      data: wrongTargetData,
    },
    {
      step: "wrong-target-attempt",
      label: "a selector outside the permission set on the granted vToken",
      target: config.venus.vToken,
      selector: BORROW_SELECTOR,
      data: wrongSelectorData,
    },
  ] as const;

  const outOfScopeRecords: ExecutionRecord[] = [];
  const outOfScopeVerdicts: ReturnType<typeof judgeRejection>[] = [];

  for (const attempt of attempts) {
    const attemptView: AccountViewAtAttempt = {
      callPermitted: await canAccountExecute(client, {
        wallet,
        keyHash: identity.keyHash,
        target: attempt.target,
        data: attempt.data,
      }),
      keyRegistered: true,
      spendLimitRaw: view.spendLimitRaw,
      spentInBucketRaw: view.spentInBucketRaw,
      allowanceRaw: view.allowanceRaw,
      balanceRaw: balanceAfter,
      amountRaw: 1n,
    };

    const outcome = await executeExpectingOutcome("REJECTION", () =>
      altana.execute({
        session,
        chainId: config.chainId,
        calls: [{ to: attempt.target, data: attempt.data }],
      }),
    );

    const record: ExecutionRecord = {
      step: attempt.step,
      label: attempt.label,
      target: attempt.target,
      selector: attempt.selector,
      status: outcome.outcome === "SUCCESS" ? "SUCCESS" : "REVERTED",
      ...(outcome.transactionHash === undefined ? {} : { txHash: outcome.transactionHash }),
    };

    const recovered =
      outcome.transactionHash === undefined
        ? { source: "NONE" as const }
        : await recoverRevertData(client, outcome.transactionHash);
    const verdict = judgeRejection({
      expected: "OUT_OF_SCOPE_CALL",
      view: attemptView,
      ...(recovered.data === undefined ? {} : { revertData: recovered.data }),
      ...(outcome.rejectionName === undefined ? {} : { thrownRejectionName: outcome.rejectionName }),
    });

    record.revertSelector = selectorOfRevert(recovered.data) ?? "";
    record.revertName = verdict.decoded?.name ?? "";
    record.revertClass = verdict.decoded?.class ?? "";
    record.attribution = attributionOf({
      view: attemptView,
      mechanism: verdict.fromAccountView.mechanism,
      decodedName: verdict.decoded?.name,
      thrownName: outcome.rejectionName,
    });

    outOfScopeRecords.push(record);
    outOfScopeVerdicts.push(verdict);
    executions.push(record);
  }

  const anySucceeded = outOfScopeRecords.some((record) => record.status === "SUCCESS");
  if (anySucceeded) {
    journal.fail("wrong-target-attempt", "an out-of-scope call succeeded");
    result.haltReason = "an out-of-scope call was not rejected";
    return result;
  }
  journal.pass(
    "wrong-target-attempt",
    `${outOfScopeRecords.length} out-of-scope call(s) submitted by the agent and rejected`,
    [
      { label: "signedBy", value: `agent session key ${context.roles.sessionKey}` },
      ...outOfScopeRecords.map((record) => ({
        label: record.label,
        value: `${record.target} ${record.selector} ${record.txHash ?? "no tx hash"}`,
      })),
    ],
  );

  journal.begin("wrong-target-rejected");
  const outOfScopeEvidence = outOfScopeVerdicts.map((verdict, index) => ({
    label: outOfScopeRecords[index]?.label ?? "attempt",
    value: verdict.observed,
  }));
  if (outOfScopeVerdicts.every((verdict) => verdict.proven)) {
    journal.pass("wrong-target-rejected", "both rejections decode to UnauthorizedCall", outOfScopeEvidence);
  } else if (outOfScopeVerdicts.some((verdict) => verdict.decoded !== undefined && !verdict.proven)) {
    journal.fail("wrong-target-rejected", "a rejection decoded to something other than UnauthorizedCall", outOfScopeEvidence);
  } else {
    journal.block("wrong-target-rejected", "revert data could not be recovered for every attempt", outOfScopeEvidence);
  }

  // ---- revoke --------------------------------------------------------------
  // Gates the registry-side revocation at the end of the sequence. Recording a
  // revocation the account never performed would put a claim on a public,
  // append-only ledger that the enforcement layer does not back.
  let sessionRevoked = false;

  journal.begin("revoke-session");
  const revoke = await altana.revokeSession({
    wallet: { address: wallet },
    signer: ownerSigner,
    session,
    chainId: config.chainId,
  });
  const afterRevoke = await readEnforcedAuthority(client, { wallet, keyHash: identity.keyHash });
  const keyStoreView = await isKeyValidInKeyStore(client, {
    keyStore: config.altana.keyStore,
    wallet,
    keyId: identity.keyId,
  });

  const revokeEvidence = [
    { label: "revokeCallsId", value: revoke.callsId },
    // The property a capital owner actually cares about: the owner alone ends
    // the session, with no cooperation from the party losing it.
    { label: "revokedBy", value: `owner ${context.roles.owner}` },
    { label: "revokedKeyHeldBy", value: `agent ${context.roles.agent}` },
    ...(revoke.transactionHash === undefined ? [] : [{ label: "revokeTxHash", value: revoke.transactionHash }]),
    { label: "accountHoldsKey", value: String(afterRevoke.registered) },
    // Reported separately and never conflated: an external registry's view is a
    // cache, and presenting a stale one as live authority is the failure this
    // whole distinction exists to prevent.
    { label: "keyStoreSaysValid", value: String(keyStoreView) },
  ];

  if (afterRevoke.registered) {
    journal.fail("revoke-session", "the account still holds the key after revocation", revokeEvidence);
    result.haltReason = "revocation did not remove the key";
    return result;
  }
  journal.pass(
    "revoke-session",
    "the owner revoked unilaterally and the account no longer holds the agent's key",
    revokeEvidence,
  );
  sessionRevoked = true;

  // ---- and prove it is dead ------------------------------------------------
  journal.begin("post-revoke-execution-fails");
  const postRevokeData = repayCalldata(1n);
  const postRevokeLimit = afterRevoke.spendLimits.find(
    (limit) => limit.token === config.venus.underlying && limit.period === "day",
  );
  // Read before the attempt, like every other refusal in this sequence. The
  // enforced-authority view above was taken between the revocation and this
  // call, so it is the account's state at the attempt rather than after it.
  const postRevokePermission = await probeCanExecute(client, {
    wallet,
    keyHash: identity.keyHash,
    target: config.venus.vToken,
    data: postRevokeData,
  });
  const postRevokeView: AccountViewAtAttempt = {
    callPermitted: postRevokePermission.permitted,
    keyRegistered: afterRevoke.registered,
    spendLimitRaw: postRevokeLimit?.limit ?? 0n,
    spentInBucketRaw: postRevokeLimit?.currentSpent ?? 0n,
    allowanceRaw: await client.readContract({
      address: config.venus.underlying,
      abi: ERC20_WRITE_ABI,
      functionName: "allowance",
      args: [wallet, config.venus.vToken],
    }),
    balanceRaw: await client.readContract({
      address: config.venus.underlying,
      abi: ERC20_WRITE_ABI,
      functionName: "balanceOf",
      args: [wallet],
    }),
    amountRaw: 1n,
  };

  const afterRevokeAttempt = await altana
    .execute({
      session,
      chainId: config.chainId,
      calls: [{ to: config.venus.vToken, data: postRevokeData }],
    })
    .catch((error: unknown) => ({
      callsId: "0x" as Hex,
      status: "FAILED" as const,
      transactionHash: undefined,
      thrown: error instanceof Error ? error.message : String(error),
    }));

  const postRevokeRecord: ExecutionRecord = {
    step: "post-revoke-execution-fails",
    label: "a previously permitted repayment, after revocation",
    target: config.venus.vToken,
    selector: REPAY_BORROW_SELECTOR,
    amountRaw: "1",
    status: afterRevokeAttempt.status === "CONFIRMED" ? "SUCCESS" : "REVERTED",
    ...(afterRevokeAttempt.transactionHash === undefined
      ? {}
      : { txHash: afterRevokeAttempt.transactionHash }),
  };
  // What the account raised when asked about this exact call. Recorded on the
  // manifest as its own artifact and deliberately NOT fed to `attributionOf`:
  // it comes from a read of `canExecute`, not from the submitted intent, and the
  // disclosure names only errors the refusal itself produced.
  if (postRevokePermission.revert !== undefined) {
    postRevokeRecord.revertSelector = postRevokePermission.revert.selector ?? "";
    postRevokeRecord.revertName = postRevokePermission.revert.name ?? "";
    postRevokeRecord.revertClass = postRevokePermission.revert.class;
  }
  // The relay refuses a call whose key hash it no longer knows, so the account's
  // validator never runs on the intent and there is no custom error from it to
  // record. The refusal is still attributed from the account's own state; the
  // disclosure then omits it rather than naming an error nothing raised.
  postRevokeRecord.attribution = attributionOf({
    view: postRevokeView,
    mechanism: attributeFromAccountView(postRevokeView).mechanism,
    thrownName:
      "thrown" in afterRevokeAttempt ? rejectionNameFrom(afterRevokeAttempt.thrown) : undefined,
  });
  executions.push(postRevokeRecord);

  if (afterRevokeAttempt.status === "CONFIRMED") {
    journal.fail("post-revoke-execution-fails", "a revoked session executed a permitted call");
    result.haltReason = "revocation did not stop execution";
    return result;
  }
  journal.pass(
    "post-revoke-execution-fails",
    `the revoked session could not execute: ${"thrown" in afterRevokeAttempt ? afterRevokeAttempt.thrown : afterRevokeAttempt.status}`,
    [
      { label: "accountHoldsKey", value: "false" },
      { label: "accountCanExecute", value: String(postRevokePermission.permitted) },
      ...(postRevokePermission.revert === undefined
        ? []
        : [
            {
              label: "canExecuteRevert",
              value: postRevokePermission.revert.name ?? postRevokePermission.revert.class,
            },
          ]),
    ],
  );

  // ---- clean up the one durable effect -------------------------------------
  journal.begin("clear-standing-approval");
  const clearTxHash = await sendAsOwner(
    config.venus.underlying,
    encodeFunctionData({
      abi: ERC20_WRITE_ABI,
      functionName: "approve",
      args: [config.venus.vToken, 0n],
    }),
  );
  const residual = await client.readContract({
    address: config.venus.underlying,
    abi: ERC20_WRITE_ABI,
    functionName: "allowance",
    args: [wallet, config.venus.vToken],
  });
  executions.push({
    step: "clear-standing-approval",
    label: "admin-path approve(vUSDT, 0)",
    target: config.venus.underlying,
    selector: "0x095ea7b3",
    amountRaw: "0",
    txHash: clearTxHash,
    status: "SUCCESS",
  });

  if (residual !== 0n) {
    journal.fail("clear-standing-approval", `the allowance still reads ${residual}`, [
      { label: "clearTxHash", value: clearTxHash },
    ]);
  } else {
    journal.pass("clear-standing-approval", "the standing allowance reads zero", [
      { label: "clearTxHash", value: clearTxHash },
      { label: "allowanceRaw", value: "0" },
    ]);
  }

  // ---- collect the run into one document -----------------------------------
  journal.begin("evidence-artifact");
  const disclosure = context.writeDisclosure({
    grantedAuthority,
    wallet,
    keyHash: identity.keyHash,
    ...(session.transactionHash === undefined ? {} : { grantTxHash: session.transactionHash }),
    executions,
  });
  journal.pass(
    "evidence-artifact",
    `${executions.length} execution(s) disclosed at ${disclosure.relativePath}`,
    [
      { label: "disclosureURI", value: disclosure.uri },
      { label: "disclosurePath", value: disclosure.relativePath },
      ...executions.map((record) => ({
        label: record.step,
        value: `${record.target} ${record.selector} ${record.status} ${record.txHash ?? "no tx hash"}`,
      })),
    ],
  );

  // ---- record the activation -----------------------------------------------
  journal.begin("record-activation");
  const grantedAuthorityHash = authorityHash(grantedAuthority);
  const mandateId = deriveMandateId({
    chainId: config.chainId,
    wallet,
    trialReceiptId: receiptId,
    grantedAuthorityHash,
    sequence: 0,
  });

  // The registry rejects a window that ends before it starts, and finding that
  // out from a reverted transaction would spend gas to learn something the run
  // already knows.
  if (validUntil <= validFrom) {
    journal.fail(
      "record-activation",
      `the account's window for this key does not describe a session: validFrom ${validFrom}, validUntil ${validUntil}`,
      [
        { label: "validFrom", value: validFrom.toString(10) },
        { label: "validUntil", value: validUntil.toString(10) },
      ],
    );
    result.haltReason = "the granted session has no usable validity window";
    return result;
  }

  const activationTxHash = await sendAsOwner(
    context.registry,
    encodeFunctionData({
      abi: REGISTRY_WRITE_ABI,
      functionName: "recordActivation",
      args: [
        receiptId,
        wallet,
        identity.keyHash,
        grantedAuthorityHash,
        0,
        disclosure.uri,
        validFrom,
        validUntil,
      ],
    }),
  );

  const activationLog = parseEventLogs({
    abi: REGISTRY_WRITE_ABI,
    eventName: "MandateActivated",
    logs: (await client.getTransactionReceipt({ hash: activationTxHash })).logs,
  })[0];

  const mandate: MandateSummary = {
    mandateId,
    grantedAuthorityHash,
    sessionKeyHash: identity.keyHash,
    sessionKeyId: identity.keyId,
    sessionPublicKey: session.publicKey,
    wallet,
    expiry,
    validFrom: Number(validFrom),
    validUntil: Number(validUntil),
    disclosureURI: disclosure.uri,
    ...(session.transactionHash === undefined ? {} : { grantTxHash: session.transactionHash }),
    ...(revoke.transactionHash === undefined ? {} : { revokeTxHash: revoke.transactionHash }),
    activationTxHash,
  };
  result.mandate = mandate;

  if (activationLog === undefined || activationLog.args.mandateId !== mandateId) {
    journal.fail(
      "record-activation",
      `the registry emitted ${activationLog?.args.mandateId ?? "no mandate id"}, not the re-derived ${mandateId}`,
      [{ label: "activationTxHash", value: activationTxHash }],
    );
    return result;
  }

  journal.pass("record-activation", `mandate ${mandateId} recorded against receipt ${receiptId}`, [
    { label: "mandateId", value: mandateId },
    { label: "activationTxHash", value: activationTxHash },
    { label: "disclosureURI", value: disclosure.uri },
    { label: "validFrom", value: validFrom.toString(10) },
    { label: "validUntil", value: validUntil.toString(10) },
  ]);

  // ---- record the revocation -----------------------------------------------
  //
  // Last, because there is no activation to revoke until the write above landed,
  // and the registry rejects a revocation for a mandate it does not hold. The
  // account was revoked long before this point; what this adds is the public
  // record of it, without which a reader finding an empty account cannot tell a
  // revoked mandate from one that was never granted.
  journal.begin("record-revocation");
  if (!sessionRevoked) {
    journal.fail(
      "record-revocation",
      "the session was never revoked on the account, so there is nothing to record",
    );
    result.haltReason = "no account-side revocation to record";
    return result;
  }

  const revocationTxHash = await sendAsOwner(
    context.registry,
    encodeFunctionData({
      abi: REGISTRY_WRITE_ABI,
      functionName: "recordRevocation",
      args: [mandateId],
    }),
  );

  const revocationLog = parseEventLogs({
    abi: REGISTRY_WRITE_ABI,
    eventName: "MandateRevoked",
    logs: (await client.getTransactionReceipt({ hash: revocationTxHash })).logs,
  })[0];

  if (revocationLog === undefined || revocationLog.args.mandateId !== mandateId) {
    journal.fail(
      "record-revocation",
      `the registry emitted ${revocationLog?.args.mandateId ?? "no mandate id"}, not the activated ${mandateId}`,
      [{ label: "revocationTxHash", value: revocationTxHash }],
    );
    return result;
  }

  const revokedAt = Number(revocationLog.args.revokedAt);
  result.mandate = { ...mandate, revokedAt, revocationTxHash };

  journal.pass(
    "record-revocation",
    `mandate ${mandateId} is on record as revoked at ${revokedAt}`,
    [
      { label: "revocationTxHash", value: revocationTxHash },
      { label: "revokedAt", value: String(revokedAt) },
    ],
  );

  return result;
}

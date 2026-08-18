/**
 * The write lane.
 *
 * Every function below changes chain state or reads state that only exists
 * because something above it did. Nothing here runs until `runPreflight`
 * returned no blockers and the operator set `PROOF_CONFIRM=1`, because granting
 * a session spends real tBNB and cannot be undone.
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
import { randomBytes } from "node:crypto";
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
  diffRequestedVsEnforced,
  hasCriticalDiscrepancy,
  isKeyValidInKeyStore,
  readEnforcedAuthority,
  sessionKeyIdentity,
  startOfSpendPeriod,
  type AuthorityDiscrepancy,
  type EnforcedAuthority,
} from "@mandate/altana";
import { authorityHash } from "@mandate/authority-ir";
import { compileAuthority, permissionsFor, profileKey } from "@mandate/authority-compiler";
import { deriveMandateId, deriveReceiptId } from "@mandate/domain";
import type { AuthorityIR, ProtocolSafetyProfile } from "@mandate/domain";
import { executeExpectingOutcome } from "./expect-rejection.js";
import { judgeRejection, type AccountViewAtAttempt } from "./attribution.js";
import type { Phase7Config } from "./config.js";
import type { ExecutionRecord, MandateSummary, ReceiptSummary } from "./manifest.js";
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
import { recoverRevertData, selectorOfRevert } from "./revert-data.js";
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
    ],
    outputs: [{ type: "bytes32" }],
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

  if (config.deployerPrivateKey === undefined) {
    throw new Error("runWriteSequence reached without a deployer key; preflight should have blocked");
  }

  const account = privateKeyToAccount(config.deployerPrivateKey);
  const walletClient: WalletClient = createWalletClient({
    account,
    chain: bscTestnet,
    transport: http(config.rpcUrl),
  });
  const altana = createAltanaClient({ chains: [BNB_TESTNET] });
  const adminSigner = signerFromPrivateKey(config.deployerPrivateKey);

  const sendAdmin = async (to: Address, data: Hex): Promise<Hex> => {
    const hash = await walletClient.sendTransaction({ account, chain: bscTestnet, to, data });
    await client.waitForTransactionReceipt({ hash });
    return hash;
  };

  // ---- publish the trial receipt -------------------------------------------
  journal.begin("publish-receipt");
  const receiptId = deriveReceiptId({
    chainId: config.chainId,
    publisher: account.address.toLowerCase() as Address,
    ...context.receiptFields,
    evidenceURI: context.evidenceURI,
  });

  const publishTxHash = await sendAdmin(
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
    publisher: account.address.toLowerCase(),
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

  // A fresh keypair every run. Altana revocation is monotonic, so a revoked
  // keyId can never be reactivated and reusing one would produce a session that
  // silently cannot act.
  const sessionSigner = signerFromPrivateKey(`0x${randomBytes(32).toString("hex")}`);

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
  const approvalTxHash = await sendAdmin(
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
  await altana.createWallet({ signer: adminSigner });

  const permissions = permissionsFor(grantedAuthority);
  const session: GrantSessionResult = await altana.grantSession({
    wallet: { address: wallet },
    signer: adminSigner,
    chainId: config.chainId,
    permissions,
    expiry,
    sessionSigner,
  });

  const identity = sessionKeyIdentity(session.publicKey);
  journal.pass("grant-session", `session key ${identity.signerAddress} granted until ${expiry}`, [
    ...(session.transactionHash === undefined
      ? []
      : [{ label: "grantTxHash", value: session.transactionHash }]),
    { label: "sessionPublicKey", value: session.publicKey },
    { label: "sessionKeyHash", value: identity.keyHash },
    { label: "sessionKeyId", value: identity.keyId },
    { label: "expiry", value: String(expiry) },
  ]);

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
  journal.pass(
    "read-enforced-authority",
    `${enforced.callRules.length} enforced call rule(s), ${enforced.spendLimits.length} spend limit(s), ${enforced.walletWideRules.length} wallet-wide rule(s)`,
    [
      { label: "observedAtBlock", value: enforced.observedAtBlock.toString(10) },
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
  journal.pass("execute-repay", `repaid ${AT_CAP_REPAY_RAW} raw USDT from the session key`, [
    { label: "callsId", value: repay.callsId },
    ...(repay.transactionHash === undefined ? [] : [{ label: "txHash", value: repay.transactionHash }]),
  ]);

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
  journal.pass("cap-breach-attempt", `the breach was rejected (${breach.status})`, [
    { label: "callsId", value: breach.callsId ?? "none" },
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
    `${outOfScopeRecords.length} out-of-scope call(s) submitted and rejected`,
    outOfScopeRecords.map((record) => ({
      label: record.label,
      value: `${record.target} ${record.selector} ${record.txHash ?? "no tx hash"}`,
    })),
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
  journal.begin("revoke-session");
  const revoke = await altana.revokeSession({
    wallet: { address: wallet },
    signer: adminSigner,
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
  journal.pass("revoke-session", "the account no longer holds the session key", revokeEvidence);

  // ---- and prove it is dead ------------------------------------------------
  journal.begin("post-revoke-execution-fails");
  const afterRevokeAttempt = await altana
    .execute({
      session,
      chainId: config.chainId,
      calls: [{ to: config.venus.vToken, data: repayCalldata(1n) }],
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
  executions.push(postRevokeRecord);

  if (afterRevokeAttempt.status === "CONFIRMED") {
    journal.fail("post-revoke-execution-fails", "a revoked session executed a permitted call");
    result.haltReason = "revocation did not stop execution";
    return result;
  }
  journal.pass(
    "post-revoke-execution-fails",
    `the revoked session could not execute: ${"thrown" in afterRevokeAttempt ? afterRevokeAttempt.thrown : afterRevokeAttempt.status}`,
    [{ label: "accountHoldsKey", value: "false" }],
  );

  // ---- clean up the one durable effect -------------------------------------
  journal.begin("clear-standing-approval");
  const clearTxHash = await sendAdmin(
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

  const activationTxHash = await sendAdmin(
    context.registry,
    encodeFunctionData({
      abi: REGISTRY_WRITE_ABI,
      functionName: "recordActivation",
      args: [receiptId, wallet, identity.keyHash, grantedAuthorityHash, 0, disclosure.uri],
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
  ]);

  return result;
}

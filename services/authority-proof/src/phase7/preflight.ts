/**
 * Everything that can be checked without spending anything.
 *
 * This is Phase 2's preflight carried forward and widened, and it keeps that
 * module's central rule: no state-changing call is made until every prerequisite
 * below has passed. A run that grants a session and then discovers the vToken
 * implementation moved has burned funds and left a live session on a wallet
 * nobody is watching.
 *
 * The checks are ordered, and the order is part of the contract. Chain identity
 * comes first because every later read is meaningless against the wrong chain;
 * the spend bucket comes before the balance because a run that cannot finish
 * inside the current UTC day should not ask an operator to fund anything.
 */
import { formatEther, getAddress } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { exposesSelector, readCodeFacts } from "@mandate/authority-analyzer";
import { REVERT_SELECTORS } from "@mandate/altana";
import {
  fatalBlocker,
  writeBlocker,
  type Blocker,
} from "./blockers.js";
import type { Phase7Config } from "./config.js";
import {
  AT_CAP_REPAY_RAW,
  BREACH_REPAY_RAW,
  loadVenusProfile,
  REPAY_BORROW_SELECTOR,
  standingAllowancePlan,
  type AllowancePlan,
} from "./plan.js";
import {
  recoverDesignationSigner,
  resolveRoles,
  undeclaredCollisions,
  type RoleAddresses,
} from "./roles.js";
import { describeBucket, readSpendBucket, type SpendBucket } from "./spend-bucket.js";
import type { Phase7Journal } from "./steps.js";

/**
 * Minimum owner balance for the whole sequence.
 *
 * The owner pays for every write, including the relay's fees for the agent's
 * executions: an Altana session is sponsored out of the wallet the session acts
 * on, so the agent's key needs no tBNB of its own and none is ever sent to it.
 *
 * Phase 2 sized 0.005 tBNB for a grant, two repayments and a revocation. Phase 7
 * adds a receipt publication, an activation record, two admin-path approvals and
 * three rejected attempts that still pay gas up to the revert. Four times the
 * Phase 2 figure leaves headroom rather than failing at the last write, which is
 * the worst place to run out: the session is live and the cleanup is unfunded.
 */
export const MINIMUM_OWNER_BALANCE_WEI = 20_000_000_000_000_000n;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
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
] as const;

const VTOKEN_READ_ABI = [
  {
    name: "borrowBalanceStored",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "implementation",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

export interface PreflightFacts {
  observedChainId: number;
  blockNumber: bigint;
  relayStatus: string;
  pinnedContracts: Array<{ label: string; address: Address; sizeBytes: number; expected: number }>;
  vTokenImplementation?: Address;
  selectorExposed?: boolean;
  bucket?: SpendBucket;
  ownerAddress?: Address;
  ownerBalanceWei?: bigint;
  /** Present once both keys resolved. Addresses only; no key material. */
  roles?: RoleAddresses;
  registryCodeSize?: number;
  walletBorrowRaw?: bigint;
  walletUnderlyingRaw?: bigint;
  walletExistingAllowanceRaw?: bigint;
  allowance: AllowancePlan;
}

export interface PreflightOutcome {
  blockers: Blocker[];
  facts: PreflightFacts;
  /** Human-facing table, one line per observation. */
  lines: string[];
}

function pinned(config: Phase7Config): Array<{ label: string; address: Address; expected: number }> {
  return [
    {
      label: "Altana account implementation",
      address: config.altana.accountImplementation,
      expected: config.altana.accountImplementationCodeSize,
    },
    { label: "Altana KeyStore", address: config.altana.keyStore, expected: 8_756 },
    { label: "Altana Orchestrator", address: config.altana.orchestrator, expected: 9_035 },
    { label: "Venus vUSDT", address: config.venus.vToken, expected: 4_744 },
    { label: "Venus Comptroller", address: config.venus.comptroller, expected: 1_508 },
    { label: "USDT mock (6 dp)", address: config.venus.underlying, expected: 2_095 },
  ];
}

/**
 * The total underlying the sequence will try to move.
 *
 * Both repayments, because the breach attempt must be able to fail on the spend
 * cap rather than on a balance the wallet never had.
 */
export const SEQUENCE_UNDERLYING_REQUIRED = AT_CAP_REPAY_RAW + BREACH_REPAY_RAW;

export async function runPreflight(
  journal: Phase7Journal,
  config: Phase7Config,
  client: PublicClient,
  now: bigint,
  runId: string,
): Promise<PreflightOutcome> {
  const blockers: Blocker[] = [];
  const lines: string[] = [];
  const facts: PreflightFacts = {
    observedChainId: 0,
    blockNumber: 0n,
    relayStatus: "",
    pinnedContracts: [],
    allowance: standingAllowancePlan(),
  };

  const label = (text: string): string => text.padEnd(32);

  journal.begin("chain-identity");
  try {
    const [observedChainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);
    facts.observedChainId = observedChainId;
    facts.blockNumber = blockNumber;
    lines.push(`${label("chain")}${observedChainId} at block ${blockNumber}`);

    if (observedChainId !== config.chainId) {
      const blocker = fatalBlocker("WRONG_CHAIN", [
        ["expected", String(config.chainId)],
        ["observed", String(observedChainId)],
        ["rpc", config.rpcUrl],
      ]);
      blockers.push(blocker);
      journal.fail("chain-identity", `RPC serves chain ${observedChainId}`);
    } else {
      journal.pass("chain-identity", `chain ${observedChainId} at block ${blockNumber}`, [
        { label: "blockNumber", value: blockNumber.toString(10) },
      ]);
    }
  } catch (error) {
    lines.push(`${label("chain")}UNREACHABLE`);
    blockers.push(
      fatalBlocker("RPC_UNREACHABLE", [
        ["rpc", config.rpcUrl],
        ["error", error instanceof Error ? error.message : String(error)],
      ]),
    );
    journal.fail("chain-identity", "the RPC did not answer");
    return { blockers, facts, lines };
  }

  journal.begin("altana-pins");
  let pinsHold = true;
  for (const contract of pinned(config)) {
    const code = await client.getCode({ address: contract.address });
    const sizeBytes = code === undefined || code === "0x" ? 0 : (code.length - 2) / 2;
    facts.pinnedContracts.push({ ...contract, sizeBytes });

    if (sizeBytes !== contract.expected) {
      pinsHold = false;
      lines.push(
        `${label(contract.label)}${sizeBytes === 0 ? "NO CODE" : `${sizeBytes} B`}, expected ${contract.expected} B`,
      );
      blockers.push(
        fatalBlocker("PINNED_CONTRACT_CHANGED", [
          ["contract", contract.label],
          ["address", contract.address],
          ["observedCodeSize", String(sizeBytes)],
          ["expectedCodeSize", String(contract.expected)],
        ]),
      );
    } else {
      lines.push(`${label(contract.label)}${sizeBytes} B, matches pin`);
    }
  }
  if (pinsHold) {
    journal.pass(
      "altana-pins",
      `${facts.pinnedContracts.length} pinned contracts match their recorded code size`,
      facts.pinnedContracts.map((contract) => ({
        label: contract.label,
        value: `${contract.address} ${contract.sizeBytes} B`,
      })),
    );
  } else {
    journal.fail("altana-pins", "at least one pinned contract was redeployed");
  }

  journal.begin("relay-health");
  const relay = await fetch(`${config.altana.relayUrl}/health`)
    .then((response) => (response.ok ? response.text() : `HTTP ${response.status}`))
    .catch((error: Error) => `unreachable: ${error.message}`);
  facts.relayStatus = relay.slice(0, 80);
  lines.push(`${label("Altana relay")}${relay.slice(0, 44)}`);
  if (relay.includes("ok")) {
    journal.pass("relay-health", relay.slice(0, 80));
  } else {
    // Every session write goes through the relay; there is no direct path.
    blockers.push(
      fatalBlocker("RELAY_UNHEALTHY", [
        ["relay", config.altana.relayUrl],
        ["response", facts.relayStatus],
      ]),
    );
    journal.fail("relay-health", facts.relayStatus);
  }

  journal.begin("venus-target");
  const profile = loadVenusProfile(config.chainId);
  const implementation = (await client.readContract({
    address: config.venus.vToken,
    abi: VTOKEN_READ_ABI,
    functionName: "implementation",
  })) as Address;
  facts.vTokenImplementation = implementation.toLowerCase() as Address;
  const implementationMatches = facts.vTokenImplementation === config.venus.vTokenImplementation;

  const implementationFacts = await readCodeFacts(client, facts.vTokenImplementation);
  const selectorExposed = exposesSelector(implementationFacts, REPAY_BORROW_SELECTOR);
  facts.selectorExposed = selectorExposed;

  lines.push(
    `${label("Venus vUSDT implementation")}${facts.vTokenImplementation} ${implementationMatches ? "matches pin" : "MOVED"}`,
  );
  lines.push(
    `${label("repayBorrow(uint256)")}${REPAY_BORROW_SELECTOR} ${selectorExposed ? "dispatched by deployed code" : "NOT FOUND in deployed code"}`,
  );

  if (!implementationMatches) {
    blockers.push(
      fatalBlocker("VENUS_IMPLEMENTATION_CHANGED", [
        ["target", config.venus.vToken],
        ["expectedImplementation", config.venus.vTokenImplementation],
        ["observedImplementation", facts.vTokenImplementation],
        ["profile", profile.profileId],
      ]),
    );
    journal.fail("venus-target", `implementation moved to ${facts.vTokenImplementation}`);
  } else if (!selectorExposed) {
    blockers.push(
      fatalBlocker("VENUS_SELECTOR_ABSENT", [
        ["target", config.venus.vToken],
        ["implementation", facts.vTokenImplementation],
        ["selector", REPAY_BORROW_SELECTOR],
      ]),
    );
    journal.fail("venus-target", `${REPAY_BORROW_SELECTOR} is not dispatched by the deployed code`);
  } else {
    journal.pass(
      "venus-target",
      `vUSDT at ${config.venus.vToken} runs the audited implementation and dispatches ${REPAY_BORROW_SELECTOR}`,
      [
        { label: "target", value: config.venus.vToken },
        { label: "implementation", value: facts.vTokenImplementation },
        { label: "implementationCodeHash", value: implementationFacts.runtimeCodeHash },
        { label: "profileId", value: profile.profileId },
      ],
    );
  }

  journal.begin("spend-bucket");
  const bucket = await readSpendBucket(client, {
    accountImplementation: config.altana.accountImplementation,
    now,
  });
  facts.bucket = bucket;
  lines.push(`${label("UTC spend bucket")}${describeBucket(bucket)}`);

  if (!bucket.semanticsMatchUtcMidnight) {
    blockers.push(
      fatalBlocker("SPEND_BUCKET_SEMANTICS_CHANGED", [
        ["accountImplementation", config.altana.accountImplementation],
        ["observedBucketStart", bucket.bucketStart.toString(10)],
        ["expectedBucketStart", ((bucket.now / 86_400n) * 86_400n).toString(10)],
        ["pinnedVectorResult", bucket.pinnedVectorResult.toString(10)],
      ]),
    );
    journal.fail("spend-bucket", "the account no longer truncates a day bucket to UTC midnight");
  } else if (!bucket.sufficientRemainder) {
    // The demo must not straddle 00:00 UTC. A rollover resets `spent`, the
    // cap-breach step succeeds, and the run reports a pass for the one step the
    // whole proof rests on.
    blockers.push(
      fatalBlocker("BUCKET_ROLLOVER_TOO_CLOSE", [
        ["bucketEndsAt", new Date(Number(bucket.bucketEnd) * 1000).toISOString()],
        ["remainingSeconds", String(bucket.remainingSeconds)],
        ["requiredSeconds", String(1_800)],
      ]),
    );
    journal.block(
      "spend-bucket",
      `only ${bucket.remainingSeconds}s remain in the current UTC bucket`,
    );
  } else {
    journal.pass("spend-bucket", describeBucket(bucket), [
      { label: "bucketStart", value: bucket.bucketStart.toString(10) },
      { label: "bucketEnd", value: bucket.bucketEnd.toString(10) },
      { label: "pinnedVectorResult", value: bucket.pinnedVectorResult.toString(10) },
    ]);
  }

  journal.begin("owner-balance");
  if (config.ownerPrivateKey === undefined) {
    lines.push(`${label("owner key")}NOT SET`);
    blockers.push(
      writeBlocker("MISSING_OWNER_KEY", [
        ["variable", "DEPLOYER_PRIVATE_KEY"],
        ["role", "owner: holds the position and the wallet's admin authority"],
        ["effect", "every write in the sequence is unreachable"],
      ]),
    );
    journal.block("owner-balance", "DEPLOYER_PRIVATE_KEY is not set");
  } else {
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(config.ownerPrivateKey);
    const balance = await client.getBalance({ address: account.address });
    facts.ownerAddress = account.address.toLowerCase() as Address;
    facts.ownerBalanceWei = balance;
    lines.push(`${label("owner")}${account.address}`);
    lines.push(`${label("owner balance")}${formatEther(balance)} tBNB`);

    if (balance < MINIMUM_OWNER_BALANCE_WEI) {
      blockers.push(
        writeBlocker("INSUFFICIENT_OWNER_BALANCE", [
          ["address", account.address],
          ["balance", `${balance} wei (${formatEther(balance)} tBNB)`],
          [
            "required",
            `${MINIMUM_OWNER_BALANCE_WEI} wei (${formatEther(MINIMUM_OWNER_BALANCE_WEI)} tBNB)`,
          ],
        ]),
      );
      journal.block("owner-balance", `${formatEther(balance)} tBNB is below the sequence minimum`);
    } else {
      journal.pass("owner-balance", `${formatEther(balance)} tBNB at ${account.address}`, [
        { label: "owner", value: account.address },
        { label: "balanceWei", value: balance.toString(10) },
      ]);
    }
  }

  // ---- the parties ---------------------------------------------------------
  //
  // Placed after the owner's key so the two addresses can be compared, and
  // before anything that writes, because a run whose roles have collapsed must
  // not publish a receipt asserting they have not.
  journal.begin("role-separation");
  if (config.agentPrivateKey === undefined) {
    lines.push(`${label("agent key")}NOT SET`);
    blockers.push(
      writeBlocker("MISSING_AGENT_KEY", [
        ["variable", "AGENT_SESSION_PRIVATE_KEY"],
        ["role", "agent: receives the session and signs the executions"],
        ["effect", "there is no second party, so no session may be granted"],
        ["remedy", "cast wallet new, then store the key in .env and never anywhere else"],
      ]),
    );
    journal.block("role-separation", "AGENT_SESSION_PRIVATE_KEY is not set");
  } else if (config.ownerPrivateKey === undefined) {
    journal.block("role-separation", "the owner key is missing, so there are no two parties to compare");
  } else {
    const roles = await resolveRoles({
      ownerPrivateKey: config.ownerPrivateKey,
      agentPrivateKey: config.agentPrivateKey,
      chainId: config.chainId,
      runId,
    });
    const addresses = roles.addresses;
    facts.roles = addresses;
    lines.push(`${label("agent")}${addresses.agent}`);
    lines.push(`${label("agent session key")}${addresses.sessionKey}`);
    lines.push(`${label("publisher")}${addresses.publisher} (same as ${addresses.publisherSameAs})`);

    // Recovered rather than assumed. If the designation the manifest publishes
    // does not recover to the agent, the pairing a reader would check is broken
    // and the run must not present it as evidence of anything.
    const designatedBy = await recoverDesignationSigner(
      addresses.designation,
      addresses.designationSignature,
    );
    const collisions = undeclaredCollisions(addresses);
    const evidence = [
      { label: "owner", value: addresses.owner },
      { label: "agent", value: addresses.agent },
      { label: "publisher", value: `${addresses.publisher} (same as ${addresses.publisherSameAs})` },
      { label: "agentSessionKey", value: addresses.sessionKey },
      { label: "sessionKeyDesignatedBy", value: designatedBy },
      { label: "designationSignature", value: addresses.designationSignature },
    ];

    if (collisions.length > 0) {
      const rendered = collisions
        .map((collision) => `${collision.left} and ${collision.right} are both ${collision.address}`)
        .join("; ");
      blockers.push(
        fatalBlocker("ROLES_COLLAPSED", [
          ...collisions.map(
            (collision) =>
              [`${collision.left}=${collision.right}`, collision.address] as const,
          ),
          ["effect", "the run would assert an arm's-length relationship that does not exist"],
        ]),
      );
      journal.fail("role-separation", rendered, evidence);
    } else if (designatedBy !== addresses.agent) {
      blockers.push(
        fatalBlocker("ROLES_COLLAPSED", [
          ["designationRecoversTo", designatedBy],
          ["agent", addresses.agent],
          ["effect", "the session key cannot be shown to have been chosen by the agent"],
        ]),
      );
      journal.fail(
        "role-separation",
        `the session-key designation recovers to ${designatedBy}, not to the agent`,
        evidence,
      );
    } else {
      journal.pass(
        "role-separation",
        `owner ${addresses.owner} and agent ${addresses.agent} are distinct, and the agent designated session key ${addresses.sessionKey}`,
        evidence,
      );
    }
  }

  journal.begin("publication-target");
  const publicationProblems: string[] = [];
  if (config.registryAddress === undefined) {
    publicationProblems.push("no registry address");
    lines.push(`${label("receipt registry")}NOT DEPLOYED (${config.registrySource})`);
    blockers.push(
      writeBlocker("MISSING_RECEIPT_REGISTRY", [
        ["lookedFor", config.registrySource],
        ["override", "MANDATE_REGISTRY_ADDRESS"],
      ]),
    );
  } else {
    const code = await client.getCode({ address: config.registryAddress });
    const size = code === undefined || code === "0x" ? 0 : (code.length - 2) / 2;
    facts.registryCodeSize = size;
    lines.push(
      `${label("receipt registry")}${config.registryAddress} ${size === 0 ? "NO CODE" : `${size} B`}`,
    );
    if (size === 0) {
      publicationProblems.push("registry has no code");
      blockers.push(
        writeBlocker("MISSING_RECEIPT_REGISTRY", [
          ["address", config.registryAddress],
          ["source", config.registrySource],
          ["observedCodeSize", "0"],
        ]),
      );
    }
  }

  if (config.evidenceBaseUri === undefined) {
    // A receipt whose `evidenceURI` points at a path only the publisher can read
    // commits to bytes nobody else can obtain, which is not publication.
    publicationProblems.push("no evidence base URI");
    lines.push(`${label("evidence base URI")}NOT SET`);
    blockers.push(
      writeBlocker("MISSING_EVIDENCE_BASE_URI", [
        ["variable", "MANDATE_EVIDENCE_BASE_URI"],
        ["accepts", "https:// or ipfs:// or r2://"],
      ]),
    );
  } else {
    lines.push(`${label("evidence base URI")}${config.evidenceBaseUri}`);
  }

  if (publicationProblems.length === 0) {
    journal.pass("publication-target", `registry ${config.registryAddress} via ${config.registrySource}`, [
      { label: "registry", value: config.registryAddress ?? "" },
      { label: "evidenceBaseUri", value: config.evidenceBaseUri ?? "" },
    ]);
  } else {
    journal.block("publication-target", publicationProblems.join("; "));
  }

  journal.begin("mandate-wallet");
  const wallet = config.walletAddress ?? facts.ownerAddress;
  if (wallet === undefined) {
    lines.push(`${label("mandate wallet")}UNKNOWN (no key and no MANDATE_WALLET_ADDRESS)`);
    blockers.push(
      writeBlocker("MISSING_MANDATE_WALLET", [
        ["variable", "MANDATE_WALLET_ADDRESS"],
        ["default", "the owner's own address, which is the Altana wallet's EIP-7702 EOA"],
      ]),
    );
    journal.block("mandate-wallet", "no wallet address is known");
  } else {
    const [borrow, underlying, existingAllowance] = await Promise.all([
      client.readContract({
        address: config.venus.vToken,
        abi: VTOKEN_READ_ABI,
        functionName: "borrowBalanceStored",
        args: [wallet],
      }),
      client.readContract({
        address: config.venus.underlying,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [wallet],
      }),
      client.readContract({
        address: config.venus.underlying,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [wallet, config.venus.vToken],
      }),
    ]);
    facts.walletBorrowRaw = borrow;
    facts.walletUnderlyingRaw = underlying;
    facts.walletExistingAllowanceRaw = existingAllowance;

    lines.push(`${label("mandate wallet")}${getAddress(wallet)}`);
    lines.push(`${label("wallet vUSDT debt")}${borrow} raw (need >= ${SEQUENCE_UNDERLYING_REQUIRED})`);
    lines.push(
      `${label("wallet USDT balance")}${underlying} raw (need >= ${SEQUENCE_UNDERLYING_REQUIRED})`,
    );

    const walletProblems: string[] = [];
    if (borrow < SEQUENCE_UNDERLYING_REQUIRED) {
      walletProblems.push("insufficient debt");
      blockers.push(
        writeBlocker("INSUFFICIENT_VENUS_DEBT", [
          ["wallet", wallet],
          ["market", config.venus.vToken],
          ["borrowBalanceRaw", borrow.toString(10)],
          ["requiredRaw", SEQUENCE_UNDERLYING_REQUIRED.toString(10)],
        ]),
      );
    }
    if (underlying < SEQUENCE_UNDERLYING_REQUIRED) {
      walletProblems.push("insufficient underlying");
      blockers.push(
        writeBlocker("INSUFFICIENT_UNDERLYING_BALANCE", [
          ["wallet", wallet],
          ["token", config.venus.underlying],
          ["balanceRaw", underlying.toString(10)],
          ["requiredRaw", SEQUENCE_UNDERLYING_REQUIRED.toString(10)],
        ]),
      );
    }

    if (walletProblems.length === 0) {
      journal.pass("mandate-wallet", `${getAddress(wallet)} holds ${borrow} raw debt and ${underlying} raw USDT`, [
        { label: "wallet", value: wallet },
        { label: "borrowBalanceRaw", value: borrow.toString(10) },
        { label: "underlyingBalanceRaw", value: underlying.toString(10) },
      ]);
    } else {
      journal.block("mandate-wallet", walletProblems.join("; "));
    }
  }

  journal.begin("allowance-sizing");
  const allowance = facts.allowance;
  lines.push(
    `${label("standing allowance")}${allowance.standingAllowance} raw, ${allowance.remainingAfterAtCap} left after the ${AT_CAP_REPAY_RAW} repayment`,
  );
  if (allowance.capBindsBreach) {
    journal.pass(
      "allowance-sizing",
      `the ${BREACH_REPAY_RAW} breach has ${allowance.headroom} raw of allowance headroom, so ${REVERT_SELECTORS["0x9054c912"]} and not an allowance failure is what must reject it`,
      [
        { label: "standingAllowanceRaw", value: allowance.standingAllowance.toString(10) },
        { label: "remainingAfterAtCapRaw", value: allowance.remainingAfterAtCap.toString(10) },
        { label: "breachAmountRaw", value: BREACH_REPAY_RAW.toString(10) },
      ],
    );
  } else {
    // Sizing the allowance to one period instead of the lifetime makes the
    // ERC-20 allowance the binding constraint. The sequence would still look
    // like it worked, and would be proving a MANDATE bug.
    blockers.push(
      fatalBlocker("ALLOWANCE_TOO_SMALL_FOR_BREACH", [
        ["standingAllowanceRaw", allowance.standingAllowance.toString(10)],
        ["remainingAfterAtCapRaw", allowance.remainingAfterAtCap.toString(10)],
        ["breachAmountRaw", BREACH_REPAY_RAW.toString(10)],
      ]),
    );
    journal.fail("allowance-sizing", "the allowance would reject the breach before the spend cap does");
  }

  return { blockers, facts, lines };
}

/** Both revert selectors the rejection steps are allowed to accept, for the record. */
export const EXPECTED_REJECTION_SELECTORS: Readonly<Record<string, Hex>> = {
  spendCap: "0x9054c912",
  outOfScope: "0xf78c1b53",
  revoked: "0xe57b6304",
};

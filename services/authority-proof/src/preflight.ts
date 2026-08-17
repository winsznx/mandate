/**
 * Preflight for the live Phase 2 proof.
 *
 * Everything that can fail without spending anything is checked here, before a
 * single write. The ordering matters: a run that grants a session, registers a
 * key for real BNB, and then discovers the balance cannot cover the repayments
 * has burned funds and left a live session behind on a wallet nobody is
 * watching.
 *
 * On insufficient balance this emits exactly the four lines the operator needs
 * and stops. Nothing else in the pipeline requires modification when the key
 * arrives.
 */
import { createPublicClient, http, formatEther } from "viem";
import type { Address, PublicClient } from "viem";
import { deploymentFor, type AltanaDeployment } from "@mandate/altana";

/**
 * Minimum admin balance.
 *
 * Key registration is ~0.00083 BNB and doubles on the wallet's first action,
 * then the proof spends gas on an approval, two repayments, two rejected
 * attempts and a revocation. Five thousandths leaves real headroom rather than
 * failing at the last step, which would be the worst place to run out.
 */
export const MINIMUM_ADMIN_BALANCE_WEI = 5_000_000_000_000_000n;

export interface PinnedContract {
  label: string;
  address: Address;
  /** Observed size at verification time. A change means a redeployment. */
  expectedCodeSize: number;
}

export type PreflightStatus = "READY" | "BLOCKED";

export interface PreflightResult {
  status: PreflightStatus;
  chainId: number;
  blockNumber: bigint;
  adminAddress?: Address;
  adminBalanceWei?: bigint;
  lines: string[];
  blockers: string[];
}

function pinnedContracts(deployment: AltanaDeployment): PinnedContract[] {
  return [
    {
      label: "Altana account implementation",
      address: deployment.accountImplementation,
      expectedCodeSize: deployment.accountImplementationCodeSize,
    },
    { label: "Altana KeyStore", address: deployment.keyStore, expectedCodeSize: 8_756 },
    { label: "Altana Orchestrator", address: deployment.orchestrator, expectedCodeSize: 9_035 },
  ];
}

/**
 * Verify a pinned contract still matches what MANDATE analysed.
 *
 * A size change is not cosmetic: every protocol safety profile and every
 * authority claim derived from this deployment described the old code. Silently
 * proceeding would produce a proof about a contract that no longer exists.
 */
async function checkPinned(
  client: PublicClient,
  contract: PinnedContract,
): Promise<{ ok: boolean; line: string }> {
  const code = await client.getCode({ address: contract.address });
  if (code === undefined || code === "0x") {
    return { ok: false, line: `${contract.label.padEnd(30)} NO CODE at ${contract.address}` };
  }
  const size = (code.length - 2) / 2;
  if (size !== contract.expectedCodeSize) {
    return {
      ok: false,
      line: `${contract.label.padEnd(30)} REDEPLOYED: ${size} B, expected ${contract.expectedCodeSize} B`,
    };
  }
  return { ok: true, line: `${contract.label.padEnd(30)} ${size} B, matches pin` };
}

export interface PreflightOptions {
  chainId: number;
  rpcUrl: string;
  /** Omit to run every check that does not need a key. */
  adminPrivateKey?: string | undefined;
  /** Venus contracts the proof will touch. */
  venusTargets: readonly PinnedContract[];
}

export async function preflight(options: PreflightOptions): Promise<PreflightResult> {
  const deployment = deploymentFor(options.chainId);
  const client = createPublicClient({ transport: http(options.rpcUrl) });

  const lines: string[] = [];
  const blockers: string[] = [];

  const blockNumber = await client.getBlockNumber();
  const observedChainId = await client.getChainId();

  if (observedChainId !== options.chainId) {
    blockers.push(`RPC reports chain ${observedChainId}, expected ${options.chainId}`);
  }
  lines.push(`chain                          ${observedChainId} at block ${blockNumber}`);

  const relay = await fetch(`${deployment.relayUrl}/health`)
    .then((response) => (response.ok ? response.text() : `HTTP ${response.status}`))
    .catch((error: Error) => `unreachable: ${error.message}`);
  if (!relay.includes("ok")) {
    // Every write goes through the relay; there is no direct-submission path.
    blockers.push(`Altana relay is not healthy: ${relay.slice(0, 80)}`);
  }
  lines.push(`Altana relay                   ${relay.slice(0, 46)}`);

  for (const contract of [...pinnedContracts(deployment), ...options.venusTargets]) {
    const result = await checkPinned(client, contract);
    lines.push(result.line);
    if (!result.ok) blockers.push(result.line.trim());
  }

  const result: PreflightResult = {
    status: "BLOCKED",
    chainId: observedChainId,
    blockNumber,
    lines,
    blockers,
  };

  if (options.adminPrivateKey === undefined || options.adminPrivateKey.length === 0) {
    blockers.push("DEPLOYER_PRIVATE_KEY is not set");
    lines.push(`admin key                      NOT SET`);
    return result;
  }

  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(options.adminPrivateKey as `0x${string}`);
  const balance = await client.getBalance({ address: account.address });

  result.adminAddress = account.address;
  result.adminBalanceWei = balance;
  lines.push(`admin address                  ${account.address}`);
  lines.push(`admin balance                  ${formatEther(balance)} BNB`);

  if (balance < MINIMUM_ADMIN_BALANCE_WEI) {
    blockers.push("insufficient tBNB");
  }

  result.status = blockers.length === 0 ? "READY" : "BLOCKED";
  return result;
}

/**
 * The exact operator-facing message for an underfunded key.
 *
 * Fixed wording so it is greppable and so the operator sees the address, what
 * is there and what is needed, without reading anything else.
 */
export function insufficientBalanceMessage(result: PreflightResult): string {
  return [
    "BLOCKED: insufficient tBNB",
    `address: ${result.adminAddress ?? "unknown"}`,
    `balance: ${result.adminBalanceWei ?? 0n} wei (${formatEther(result.adminBalanceWei ?? 0n)} BNB)`,
    `required minimum: ${MINIMUM_ADMIN_BALANCE_WEI} wei (${formatEther(MINIMUM_ADMIN_BALANCE_WEI)} BNB)`,
  ].join("\n");
}

export function renderPreflight(result: PreflightResult): string {
  const body = result.lines.join("\n");
  if (result.status === "READY") return `${body}\n\nREADY: preflight passed, no writes performed yet`;

  if (result.blockers.includes("insufficient tBNB")) {
    return `${body}\n\n${insufficientBalanceMessage(result)}`;
  }

  return [body, "", `BLOCKED: ${result.blockers.length} prerequisite(s) missing`, ...result.blockers.map((blocker) => `  - ${blocker}`)].join("\n");
}

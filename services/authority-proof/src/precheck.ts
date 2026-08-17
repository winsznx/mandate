/**
 * Report exactly what the Phase 2 live proof still needs.
 *
 * Run before `prove` so a missing secret is a one-line answer rather than a
 * failure halfway through a sequence that has already granted a session and
 * spent testnet funds.
 *
 *   pnpm --filter @mandate/authority-proof exec tsx src/precheck.ts
 */
import { createPublicClient, http } from "viem";
import type { Address } from "viem";
import { BSC_TESTNET } from "@mandate/altana";

const RPC_URL = process.env.BSC_TESTNET_RPC_URL ?? "https://bsc-testnet-rpc.publicnode.com";

const CONTRACTS: ReadonlyArray<readonly [string, Address]> = [
  ["Venus vUSDT", "0xb7526572ffe56ab9d7489838bf2e18e3323b441a"],
  ["USDT mock (6 dp)", "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c"],
  ["Venus Comptroller", "0x94d1820b2d1c7c7452a163983dc888cec546b77d"],
  ["Altana KeyStore", BSC_TESTNET.keyStore],
  ["Altana account impl", BSC_TESTNET.accountImplementation],
  ["Altana Orchestrator", BSC_TESTNET.orchestrator],
];

const client = createPublicClient({ transport: http(RPC_URL) });
const lines: string[] = [];
let blocked = 0;

const head = await client.getBlockNumber();
lines.push(`chain 97 RPC              head ${head}`);

const relay = await fetch(`${BSC_TESTNET.relayUrl}/health`)
  .then((response) => response.text())
  .catch((error: Error) => `unreachable: ${error.message}`);
lines.push(`Altana testnet relay      ${relay.slice(0, 56)}`);

for (const [label, address] of CONTRACTS) {
  const code = await client.getCode({ address });
  const present = code !== undefined && code !== "0x";
  if (!present) blocked += 1;
  lines.push(`${label.padEnd(25)} ${present ? `code ${(code!.length - 2) / 2} B` : "NO CODE"}`);
}

/**
 * The live proof needs a funded admin key. Everything above is public
 * infrastructure that is either there or not; this is the one input only the
 * operator can supply.
 */
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (privateKey === undefined || privateKey.length === 0) {
  blocked += 1;
  lines.push(`DEPLOYER_PRIVATE_KEY      NOT SET`);
} else {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const balance = await client.getBalance({ address: account.address });
  // grantSession costs roughly 0.00083 BNB per key registration, doubled on the
  // wallet's first action, plus gas for the repayments and the revocation.
  const sufficient = balance >= 5_000_000_000_000_000n;
  if (!sufficient) blocked += 1;
  lines.push(`admin key                 ${account.address}`);
  lines.push(
    `admin balance             ${balance} wei${sufficient ? "" : "  INSUFFICIENT, need >= 0.005 tBNB"}`,
  );
}

lines.push("");
lines.push(blocked === 0 ? "READY: the live proof can run" : `BLOCKED: ${blocked} prerequisite(s) missing`);

process.stdout.write(`${lines.join("\n")}\n`);
process.exitCode = blocked === 0 ? 0 : 1;

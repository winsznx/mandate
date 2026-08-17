/**
 * Generate the ProtocolSafetyProfile for Venus `vUSDT.repayBorrow(uint256)`.
 *
 * Phase 1's completion gate is a verdict backed by executable evidence, so this
 * reads live chain state rather than asserting a conclusion. Run it before any
 * session is designed around the call, and re-run it whenever the profile's
 * freshness lapses: the target is an upgradeable delegator, so the code it
 * describes can change without the address changing.
 *
 *   pnpm --filter @mandate/authority-analyzer analyze:venus
 *
 * Writes `artifacts/protocol-profiles/venus/<chainId>-<selector>.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";
import { ProtocolSafetyProfileSchema, type ProtocolSafetyProfile } from "@mandate/domain";
import { readCodeFacts, resolveProxy, exposesSelector } from "../src/bytecode.js";

const ANALYZER_VERSION = "1.0.0";

const TARGETS = {
  97: {
    rpcUrl: process.env.BSC_TESTNET_RPC_URL ?? "https://bsc-testnet-rpc.publicnode.com",
    vUSDT: "0xb7526572ffe56ab9d7489838bf2e18e3323b441a" as Address,
    comptroller: "0x94d1820b2d1c7c7452a163983dc888cec546b77d" as Address,
  },
  56: {
    rpcUrl: process.env.BSC_RPC_URL ?? "https://bsc-rpc.publicnode.com",
    vUSDT: "0xfd5840cd36d94d7229439859c0112a4185bc0255" as Address,
    comptroller: "0xfd36e2c2a6789db23113685031d7f16329158384" as Address,
  },
} as const;

const VTOKEN_ABI = [
  { name: "underlying", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "admin", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "implementation", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const ERC20_ABI = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

async function analyze(chainId: 56 | 97): Promise<ProtocolSafetyProfile> {
  const config = TARGETS[chainId];
  const client = createPublicClient({ transport: http(config.rpcUrl) });

  const blockNumber = await client.getBlockNumber();
  const selector = toFunctionSelector("repayBorrow(uint256)") as Hex;

  const proxyFacts = await readCodeFacts(client, config.vUSDT, blockNumber);
  const proxy = await resolveProxy(client, config.vUSDT, blockNumber);

  if (proxy.implementation === undefined) {
    throw new Error(`Could not resolve the implementation behind ${config.vUSDT}`);
  }

  const implementationFacts = await readCodeFacts(client, proxy.implementation, blockNumber);

  const [underlying, admin] = await Promise.all([
    client.readContract({ address: config.vUSDT, abi: VTOKEN_ABI, functionName: "underlying", blockNumber }),
    client.readContract({ address: config.vUSDT, abi: VTOKEN_ABI, functionName: "admin", blockNumber }),
  ]);

  const [underlyingSymbol, underlyingDecimals] = await Promise.all([
    client.readContract({ address: underlying, abi: ERC20_ABI, functionName: "symbol", blockNumber }),
    client.readContract({ address: underlying, abi: ERC20_ABI, functionName: "decimals", blockNumber }),
  ]);

  const unresolvedRisks: string[] = [];

  if (!exposesSelector(implementationFacts, selector)) {
    unresolvedRisks.push(
      `repayBorrow(uint256) ${selector} was not found in the implementation's selector dispatch`,
    );
  }

  // The implementation is the only code that runs on this path, so its opcode
  // profile is what bounds the call. A delegatecall inside it would mean the
  // reachable code is not the code that was analysed.
  if (implementationFacts.scan.delegateCall) {
    unresolvedRisks.push("The implementation contains DELEGATECALL, so reachable code is not fully pinned");
  }
  if (implementationFacts.scan.selfDestruct) {
    unresolvedRisks.push("The implementation contains SELFDESTRUCT");
  }

  const profile: ProtocolSafetyProfile = {
    schemaVersion: "mandate.protocol-safety-profile/1",
    profileId: `venus-vusdt-repayborrow-${chainId}`,
    chainId,
    protocolId: "venus",
    target: config.vUSDT,
    selector,
    signature: "repayBorrow(uint256)",
    runtimeCodeHash: proxyFacts.runtimeCodeHash,
    implementation: proxy.implementation,
    implementationCodeHash: implementationFacts.runtimeCodeHash,
    proxyType: proxy.proxyType === "NONE" ? "NONE" : proxy.proxyType,
    // A Compound delegator's admin can point it at new logic at any time, so the
    // profile is true only for as long as this code hash holds.
    upgradeable: true,
    upgradeAdmin: admin.toLowerCase() as Address,

    // repayBorrow(uint256) takes a single amount. There is no address argument,
    // so the payer, the beneficiary and the asset are all fixed: the payer is
    // msg.sender, the debt reduced is msg.sender's own, and the asset is the
    // vToken's immutable underlying. This is precisely why it is the first
    // proof and repayBorrowBehalf(address,uint256) is not.
    arbitraryRecipient: false,
    arbitraryAsset: false,
    arbitraryDownstreamTarget: false,
    delegateCallReachable: implementationFacts.scan.delegateCall,
    multicallReachable: false,
    // The protocol pulls the underlying with transferFrom, so a standing
    // allowance is required. It is created by the admin, not by the session.
    createsPersistentApproval: true,
    callbackReachable: false,

    verdict: unresolvedRisks.length === 0 ? "DIRECT_SAFE" : "GUARD_REQUIRED",
    supportedConstraints: ["target", "selector", "spend-cap", "expiry"],
    unresolvedRisks,

    analyzedAtBlock: blockNumber.toString(10),
    analyzedAt: Math.floor(Date.now() / 1000),
    analyzerVersion: ANALYZER_VERSION,
  };

  const parsed = ProtocolSafetyProfileSchema.parse(profile);

  process.stdout.write(
    [
      ``,
      `chain ${chainId}  block ${blockNumber}`,
      `  target          ${config.vUSDT} (${proxyFacts.sizeBytes} B, ${proxy.proxyType})`,
      `  implementation  ${proxy.implementation} (${implementationFacts.sizeBytes} B)`,
      `  implCodeHash    ${implementationFacts.runtimeCodeHash}`,
      `  upgrade admin   ${admin}`,
      `  underlying      ${underlying} ${underlyingSymbol} ${underlyingDecimals} dp`,
      `  selector found  ${exposesSelector(implementationFacts, selector)}`,
      `  delegatecall    ${implementationFacts.scan.delegateCall}`,
      `  selfdestruct    ${implementationFacts.scan.selfDestruct}`,
      `  VERDICT         ${parsed.verdict}`,
      ...unresolvedRisks.map((risk) => `  risk            ${risk}`),
      ``,
    ].join("\n"),
  );

  return parsed;
}

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, "..", "..", "..", "artifacts", "protocol-profiles", "venus");
mkdirSync(outputDir, { recursive: true });

for (const chainId of [97, 56] as const) {
  try {
    const profile = await analyze(chainId);
    const path = join(outputDir, `${chainId}-${profile.selector}.json`);
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    process.stdout.write(`wrote ${path}\n`);
  } catch (error) {
    process.stderr.write(`chain ${chainId} analysis failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

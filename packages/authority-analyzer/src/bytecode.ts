/**
 * Bytecode-level facts about a deployed contract.
 *
 * The Effective Authority Analyzer asks one question: given only permission to
 * invoke this selector on this target, what is reachable? Answering it from
 * documentation is worthless, because documentation describes intent and an
 * attacker uses the deployment. So everything here is derived from runtime
 * bytecode and storage read off the live chain.
 *
 * Opcode scanning is a conservative screen, not a decompiler. A contract with
 * zero `DELEGATECALL` bytes provably cannot delegatecall; one that contains the
 * opcode may or may not reach it on this selector's path. Absence is therefore
 * proof and presence is only suspicion, which is the right asymmetry for a
 * check that gates a `DIRECT_SAFE` verdict.
 */
import { keccak256, slice, toHex } from "viem";
import type { Address, Hex, PublicClient } from "viem";

/** EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1. */
export const EIP1967_IMPLEMENTATION_SLOT: Hex =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** EIP-1967 admin slot: keccak256("eip1967.proxy.admin") - 1. */
export const EIP1967_ADMIN_SLOT: Hex =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/**
 * Compound's `VBep20Delegator` keeps its implementation in a plain slot rather
 * than an EIP-1967 one, so a reader that only checks the standard slots
 * concludes "not a proxy" about a contract that is very much a proxy.
 */
export const COMPOUND_DELEGATOR_IMPLEMENTATION_SLOT = 18n;
export const COMPOUND_DELEGATOR_UNDERLYING_SLOT = 17n;

/** Opcodes whose absence bounds what a call can reach. */
const OPCODES = {
  DELEGATECALL: 0xf4,
  CALLCODE: 0xf2,
  SELFDESTRUCT: 0xff,
  CREATE: 0xf0,
  CREATE2: 0xf5,
  CALL: 0xf1,
} as const;

export interface OpcodeScan {
  delegateCall: boolean;
  callCode: boolean;
  selfDestruct: boolean;
  create: boolean;
  externalCall: boolean;
  /** Every 4-byte selector that appears as a PUSH4 immediate. */
  push4Selectors: Set<string>;
}

/**
 * Walk runtime bytecode, skipping PUSH immediates.
 *
 * Naively searching for a byte value finds `0xf4` inside a PUSH32 constant and
 * reports a delegatecall that does not exist. Since a false `delegateCall: true`
 * downgrades a correct `DIRECT_SAFE` to `GUARD_REQUIRED`, and a false negative
 * would do the reverse, the immediates have to be skipped properly.
 */
export function scanOpcodes(runtimeCode: Hex): OpcodeScan {
  const bytes = Buffer.from(runtimeCode.slice(2), "hex");
  const scan: OpcodeScan = {
    delegateCall: false,
    callCode: false,
    selfDestruct: false,
    create: false,
    externalCall: false,
    push4Selectors: new Set(),
  };

  let index = 0;
  while (index < bytes.length) {
    const opcode = bytes[index]!;

    // PUSH1 (0x60) through PUSH32 (0x7f) carry their operand inline.
    if (opcode >= 0x60 && opcode <= 0x7f) {
      const width = opcode - 0x5f;
      if (opcode === 0x63 && index + 4 < bytes.length) {
        scan.push4Selectors.add(`0x${bytes.subarray(index + 1, index + 5).toString("hex")}`);
      }
      index += 1 + width;
      continue;
    }

    switch (opcode) {
      case OPCODES.DELEGATECALL:
        scan.delegateCall = true;
        break;
      case OPCODES.CALLCODE:
        scan.callCode = true;
        break;
      case OPCODES.SELFDESTRUCT:
        scan.selfDestruct = true;
        break;
      case OPCODES.CREATE:
      case OPCODES.CREATE2:
        scan.create = true;
        break;
      case OPCODES.CALL:
        scan.externalCall = true;
        break;
      default:
        break;
    }

    index += 1;
  }

  return scan;
}

export interface ProxyResolution {
  proxyType: "NONE" | "EIP1967" | "DELEGATOR" | "UNKNOWN";
  implementation?: Address;
  admin?: Address;
}

function addressFromSlot(word: Hex): Address | undefined {
  const address = `0x${word.slice(-40)}`.toLowerCase() as Address;
  return address === "0x0000000000000000000000000000000000000000" ? undefined : address;
}

/**
 * Identify the proxy pattern, if any.
 *
 * Checks the EIP-1967 slots first, then Compound's plain-slot layout. A proxy
 * mistaken for a plain contract produces a profile pinned to the wrong code
 * hash, which then fails to notice the upgrade it exists to notice.
 */
export async function resolveProxy(
  client: PublicClient,
  target: Address,
  blockNumber?: bigint,
): Promise<ProxyResolution> {
  const at = blockNumber === undefined ? {} : { blockNumber };

  const [eip1967Impl, eip1967Admin] = await Promise.all([
    client.getStorageAt({ address: target, slot: EIP1967_IMPLEMENTATION_SLOT, ...at }),
    client.getStorageAt({ address: target, slot: EIP1967_ADMIN_SLOT, ...at }),
  ]);

  const standardImplementation = eip1967Impl === undefined ? undefined : addressFromSlot(eip1967Impl);
  if (standardImplementation !== undefined) {
    const resolution: ProxyResolution = {
      proxyType: "EIP1967",
      implementation: standardImplementation,
    };
    const admin = eip1967Admin === undefined ? undefined : addressFromSlot(eip1967Admin);
    if (admin !== undefined) resolution.admin = admin;
    return resolution;
  }

  const delegatorSlot = await client.getStorageAt({
    address: target,
    slot: toHex(COMPOUND_DELEGATOR_IMPLEMENTATION_SLOT, { size: 32 }),
    ...at,
  });
  const delegatorImplementation = delegatorSlot === undefined ? undefined : addressFromSlot(delegatorSlot);

  if (delegatorImplementation !== undefined) {
    return { proxyType: "DELEGATOR", implementation: delegatorImplementation };
  }

  return { proxyType: "NONE" };
}

export interface CodeFacts {
  address: Address;
  runtimeCode: Hex;
  runtimeCodeHash: Hex;
  sizeBytes: number;
  scan: OpcodeScan;
}

export async function readCodeFacts(
  client: PublicClient,
  address: Address,
  blockNumber?: bigint,
): Promise<CodeFacts> {
  const code = await client.getCode({
    address,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });

  if (code === undefined || code === "0x") {
    throw new Error(`No code is deployed at ${address}`);
  }

  return {
    address,
    runtimeCode: code,
    runtimeCodeHash: keccak256(code),
    sizeBytes: (code.length - 2) / 2,
    scan: scanOpcodes(code),
  };
}

/** Does the runtime contain a dispatch entry for this selector? */
export function exposesSelector(facts: CodeFacts, selector: Hex): boolean {
  return facts.scan.push4Selectors.has(selector.toLowerCase());
}

/** First four bytes of calldata, or undefined when there are fewer than four. */
export function selectorOf(data: Hex): Hex | undefined {
  return (data.length - 2) / 2 < 4 ? undefined : (slice(data, 0, 4).toLowerCase() as Hex);
}

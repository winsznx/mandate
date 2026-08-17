/**
 * Altana deployment facts, verified on chain on 2026-08-17.
 *
 * Everything here was read from the live chain or from the published
 * `@altananetwork/sdk@0.7.1` tarball rather than from documentation. Code sizes
 * are recorded so a future run can detect a redeployment: if a size or hash
 * moves, the enforcement layer changed and every protocol safety profile that
 * depended on it is stale.
 */
import type { Address, Hex } from "viem";

/** Pinned exactly. The SDK pins `porto@0.2.37`, and a porto bump changes key-hash derivation. */
export const ALTANA_SDK_VERSION = "0.7.1" as const;

/**
 * Wildcards the account contract treats as "match anything".
 *
 * These are real addresses in the permission set, not sentinels the SDK strips.
 * A permission whose target is `ANY_TARGET` grants every target, so the reader
 * has to recognise them or it will report a wildcard grant as a narrow one.
 */
export const ANY_TARGET: Address = "0x3232323232323232323232323232323232323232";
export const ANY_FN_SEL: Hex = "0x32323232";
/** Calls with empty calldata get this selector, not `ANY_FN_SEL`. */
export const EMPTY_CALLDATA_FN_SEL: Hex = "0xe0e0e0e0";
/** Wallet-wide permission set applied to every key on the account, regardless of key hash. */
export const ANY_KEYHASH: Hex = `0x${"32".repeat(32)}`;

/** `KeyType` enum in the account contract. MANDATE only ever grants Secp256k1 session keys. */
export const KEY_TYPE = { P256: 0, WebAuthnP256: 1, Secp256k1: 2, External: 3 } as const;

/**
 * On-chain `SpendPeriod` enum.
 *
 * `Forever` exists in the contract but the SDK cannot express it, so MANDATE
 * never emits it and treats it as a red flag if one is ever observed.
 */
export const SPEND_PERIOD_ENUM = {
  0: "minute",
  1: "hour",
  2: "day",
  3: "week",
  4: "month",
  5: "year",
  6: "forever",
} as const satisfies Record<number, string>;

/**
 * Revert selectors, for turning a bare `status: "FAILED"` into a reason.
 *
 * The SDK returns no revert string, so distinguishing a spend-cap rejection
 * from an unfunded wallet requires decoding the trace ourselves. The whole
 * demo turns on that distinction: `ExceededSpendLimit` is the product working,
 * an allowance failure is a misconfiguration wearing the same costume.
 */
export const REVERT_SELECTORS = {
  "0x9054c912": "ExceededSpendLimit(address)",
  "0x5ee7e5b1": "NoSpendPermissions()",
  "0xf78c1b53": "UnauthorizedCall(bytes32,address,bytes)",
  "0xe57b6304": "KeyDoesNotExist()",
  "0x0e9be31c": "CannotSelfExecute()",
} as const;

export type RevertSelector = keyof typeof REVERT_SELECTORS;

export interface AltanaDeployment {
  chainId: number;
  name: string;
  relayUrl: string;
  keyStore: Address;
  keyStoreController: Address;
  accountImplementation: Address;
  orchestrator: Address;
  /** Observed runtime code size in bytes, for redeployment detection. */
  accountImplementationCodeSize: number;
  /** Fee token the relay advertises. Native only on both BSC chains. */
  feeToken: "NATIVE";
}

export const BSC_MAINNET: AltanaDeployment = {
  chainId: 56,
  name: "BNB Smart Chain",
  relayUrl: "https://relay.altana.network",
  keyStore: "0x6572427ed530badcf7375cf9a4709d8d2b0e7e0a",
  keyStoreController: "0x0834ee2c9bdc3e3eff0a2dc34393d4b0e546a555",
  accountImplementation: "0x4b5d20cd8a3927b500540d9bccddc27385c9fa79",
  orchestrator: "0xaf140d0416a994aebb3fa6212b16ce6700f09751",
  accountImplementationCodeSize: 23_384,
  feeToken: "NATIVE",
};

export const BSC_TESTNET: AltanaDeployment = {
  chainId: 97,
  name: "BNB Smart Chain Testnet",
  relayUrl: "https://testnet-relay.altana.network",
  keyStore: "0x6b8361c29d05d498b1a12b54a37310f94171e94a",
  keyStoreController: "0xb530d1971f5453f3359518343f05d0aedfff7e12",
  accountImplementation: "0x33ad2f49ab9f122f5f0fdf579f575724eff353de",
  orchestrator: "0xcb5cef3c54aa90e9a7ad602a258d3d360cc862b9",
  accountImplementationCodeSize: 23_384,
  feeToken: "NATIVE",
};

export const DEPLOYMENTS: Record<number, AltanaDeployment> = {
  56: BSC_MAINNET,
  97: BSC_TESTNET,
};

export function deploymentFor(chainId: number): AltanaDeployment {
  const deployment = DEPLOYMENTS[chainId];
  if (deployment === undefined) {
    throw new Error(`No Altana deployment is known for chain ${chainId}`);
  }
  return deployment;
}

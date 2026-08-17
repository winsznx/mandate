/**
 * Reading enforced authority directly from the account contract.
 *
 * This module exists because `session.permissions` is not what gets enforced.
 * The SDK hands the requested permissions to Porto, which rewrites them before
 * they reach the chain — most notably by appending a wildcard-selector call
 * permission for the Orchestrator to every session key. An interface that
 * displays the requested object is therefore showing the user something that
 * was true only before the grant.
 *
 * MANDATE reads `canExecutePackedInfos` and `spendInfos` from the wallet and
 * treats those as the authority. Everything else is a request.
 *
 * One deployment detail matters: the wallet is an EIP-7702 EOA delegating to
 * the account implementation, so every call below targets the WALLET address.
 * Calling the implementation address returns the implementation's own empty
 * storage, which looks like a session with no permissions at all.
 */
import { getAddress, sliceHex } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { ANY_FN_SEL, ANY_KEYHASH, ANY_TARGET, SPEND_PERIOD_ENUM } from "./constants.js";

export const ACCOUNT_ABI = [
  {
    name: "canExecutePackedInfos",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ type: "bytes32[]" }],
  },
  {
    name: "canExecute",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "spendInfos",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "period", type: "uint8" },
          { name: "limit", type: "uint256" },
          { name: "spent", type: "uint256" },
          { name: "lastUpdated", type: "uint256" },
          { name: "currentSpent", type: "uint256" },
          { name: "current", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "expiry", type: "uint40" },
          { name: "keyType", type: "uint8" },
          { name: "isSuperAdmin", type: "bool" },
          { name: "publicKey", type: "bytes" },
        ],
      },
      { type: "bytes32[]" },
    ],
    inputs: [],
  },
  {
    name: "startOfSpendPeriod",
    type: "function",
    stateMutability: "pure",
    inputs: [
      { name: "unixTimestamp", type: "uint256" },
      { name: "period", type: "uint8" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const KEYSTORE_ABI = [
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
] as const;

/**
 * One `(target, selector)` rule as the account stores it.
 *
 * `_packCanExecute` lays the entry out as `target(20) || zeros(8) || selector(4)`,
 * so the two halves are read off opposite ends of the word.
 */
export interface EnforcedCallRule {
  target: Address;
  selector: Hex;
  /** True when `target` is the wildcard, meaning every contract is reachable. */
  targetIsWildcard: boolean;
  /** True when `selector` is the wildcard, meaning every method on the target is reachable. */
  selectorIsWildcard: boolean;
  /** The raw storage word, kept so evidence can quote what was actually read. */
  packed: Hex;
}

export function decodeCanExecuteEntry(packed: Hex): EnforcedCallRule {
  const target = getAddress(sliceHex(packed, 0, 20)).toLowerCase() as Address;
  const selector = sliceHex(packed, 28, 32);
  return {
    target,
    selector,
    targetIsWildcard: target === ANY_TARGET,
    selectorIsWildcard: selector === ANY_FN_SEL,
    packed,
  };
}

export interface EnforcedSpendLimit {
  /** Zero address denotes the native token. */
  token: Address;
  period: (typeof SPEND_PERIOD_ENUM)[keyof typeof SPEND_PERIOD_ENUM];
  periodEnum: number;
  limit: bigint;
  /** Consumed within the bucket that is currently open. */
  currentSpent: bigint;
  /** Unix seconds at which the current bucket opened. */
  currentPeriodStart: bigint;
  /** What remains before the next call reverts with `ExceededSpendLimit`. */
  remaining: bigint;
}

/**
 * Everything the chain enforces for one session key.
 *
 * `walletWideRules` is read separately and deliberately. The account also
 * consults a permission set stored under a wallet-wide key hash that applies to
 * every key on the account. A rule there widens this session without appearing
 * in its own permission set, so reporting only the session's rules would
 * understate the authority.
 */
export interface EnforcedAuthority {
  wallet: Address;
  keyHash: Hex;
  /** Absent when the account holds no key with this hash. */
  registered: boolean;
  expiry: number;
  isSuperAdmin: boolean;
  callRules: EnforcedCallRule[];
  walletWideRules: EnforcedCallRule[];
  spendLimits: EnforcedSpendLimit[];
  observedAtBlock: bigint;
}

/**
 * Read the enforced authority for a session key.
 *
 * Reads are pinned to a single block so the returned picture is internally
 * consistent. At BSC's sub-second block time an unpinned multi-read can span
 * several blocks and mix pre- and post-execution spend counters.
 */
export async function readEnforcedAuthority(
  client: PublicClient,
  params: { wallet: Address; keyHash: Hex; blockNumber?: bigint },
): Promise<EnforcedAuthority> {
  const blockNumber = params.blockNumber ?? (await client.getBlockNumber());
  const at = { blockNumber } as const;

  const [packedRules, walletWidePacked, spendInfos, keys] = await Promise.all([
    client.readContract({
      address: params.wallet,
      abi: ACCOUNT_ABI,
      functionName: "canExecutePackedInfos",
      args: [params.keyHash],
      ...at,
    }),
    client.readContract({
      address: params.wallet,
      abi: ACCOUNT_ABI,
      functionName: "canExecutePackedInfos",
      args: [ANY_KEYHASH],
      ...at,
    }),
    client.readContract({
      address: params.wallet,
      abi: ACCOUNT_ABI,
      functionName: "spendInfos",
      args: [params.keyHash],
      ...at,
    }),
    client.readContract({ address: params.wallet, abi: ACCOUNT_ABI, functionName: "getKeys", ...at }),
  ]);

  const [keyRecords, keyHashes] = keys;
  const index = keyHashes.findIndex((hash) => hash.toLowerCase() === params.keyHash.toLowerCase());
  const record = index >= 0 ? keyRecords[index] : undefined;

  return {
    wallet: params.wallet,
    keyHash: params.keyHash,
    registered: record !== undefined,
    expiry: record === undefined ? 0 : Number(record.expiry),
    isSuperAdmin: record?.isSuperAdmin ?? false,
    callRules: packedRules.map(decodeCanExecuteEntry),
    walletWideRules: walletWidePacked.map(decodeCanExecuteEntry),
    spendLimits: spendInfos.map((info) => ({
      token: info.token.toLowerCase() as Address,
      period: SPEND_PERIOD_ENUM[info.period as keyof typeof SPEND_PERIOD_ENUM] ?? "forever",
      periodEnum: info.period,
      limit: info.limit,
      currentSpent: info.currentSpent,
      currentPeriodStart: info.current,
      remaining: info.limit > info.currentSpent ? info.limit - info.currentSpent : 0n,
    })),
    observedAtBlock: blockNumber,
  };
}

/**
 * Ask the account itself whether a call would be permitted.
 *
 * Useful as a cross-check on MANDATE's own reasoning: if the reconstruction says
 * a call is out of scope and the account says it is allowed, the reconstruction
 * is wrong, and that is the one bug that would make the whole product lie.
 */
export async function canAccountExecute(
  client: PublicClient,
  params: { wallet: Address; keyHash: Hex; target: Address; data: Hex; blockNumber?: bigint },
): Promise<boolean> {
  return client.readContract({
    address: params.wallet,
    abi: ACCOUNT_ABI,
    functionName: "canExecute",
    args: [params.keyHash, params.target, params.data],
    ...(params.blockNumber === undefined ? {} : { blockNumber: params.blockNumber }),
  });
}

/**
 * Start of the calendar bucket a timestamp falls into, as the deployed contract
 * computes it.
 *
 * Read from chain rather than reimplemented, because week, month and year
 * boundaries are calendar arithmetic that is easy to get subtly wrong, and a
 * MANDATE-side approximation that disagreed with the enforcer would produce a
 * spend readout the user cannot rely on.
 */
export async function startOfSpendPeriod(
  client: PublicClient,
  params: { wallet: Address; timestamp: bigint; periodEnum: number },
): Promise<bigint> {
  return client.readContract({
    address: params.wallet,
    abi: ACCOUNT_ABI,
    functionName: "startOfSpendPeriod",
    args: [params.timestamp, params.periodEnum],
  });
}

/** Whether the public KeyStore still considers a key live. */
export async function isKeyValidInKeyStore(
  client: PublicClient,
  params: { keyStore: Address; wallet: Address; keyId: Hex },
): Promise<boolean> {
  return client.readContract({
    address: params.keyStore,
    abi: KEYSTORE_ABI,
    functionName: "isValidKey",
    args: [params.wallet, params.keyId],
  });
}

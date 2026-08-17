/**
 * Chain access. Facts in, facts out.
 *
 * `observeAccount` enumerates every listed market rather than the entered
 * subset, and reads VAI from its own controller. Both choices exist because the
 * obvious alternatives lose debt: `getAssetsIn` omits any market the account did
 * not enter and omits VAI entirely, and `Comptroller.mintedVAIs` reports
 * principal without accrued interest.
 *
 * Nothing here decides whether a position is healthy. That judgement is made
 * twice, independently, by the agent and by the reference model.
 */
import { getAddress } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { COMPTROLLER_ABI, ERC20_ABI, ORACLE_ABI, VAI_CONTROLLER_ABI, VTOKEN_ABI } from "./abis.js";
import type { VenusDeployment } from "./addresses.js";
import { NATIVE_UNDERLYING_DECIMALS } from "./errors.js";
import {
  VENUS_OBSERVATION_SCHEMA_VERSION,
  type RawMarketObservation,
  type RawVenusObservation,
} from "./observation.js";

function normalize(address: string): Address {
  return getAddress(address).toLowerCase() as Address;
}

/**
 * Read one market.
 *
 * `underlying()` reverts on `vBNB`, which represents native BNB and has no
 * ERC-20 behind it. That is expected rather than exceptional, so it falls back
 * to the native decimals instead of failing the whole observation.
 */
async function observeMarket(
  client: PublicClient,
  comptroller: Address,
  oracle: Address,
  vToken: Address,
  account: Address,
  entered: boolean,
  blockNumber: bigint,
): Promise<RawMarketObservation> {
  const at = { blockNumber } as const;

  // Balances come from the vToken and metadata from the Comptroller, so a
  // market whose metadata is unreadable can still be shown to carry exposure.
  // That combination is exactly what a consumer has to fail closed on.
  const [metadata, balances] = await Promise.all([
    client
      .readContract({ address: comptroller, abi: COMPTROLLER_ABI, functionName: "markets", args: [vToken], ...at })
      .then((value) => ({ value, reason: undefined as string | undefined }))
      .catch((error: Error) => ({
        value: null,
        reason: error.message.split("\n")[0] ?? "markets() reverted",
      })),
    Promise.all([
      client.readContract({ address: vToken, abi: VTOKEN_ABI, functionName: "getAccountSnapshot", args: [account], ...at }),
      client.readContract({ address: vToken, abi: VTOKEN_ABI, functionName: "borrowBalanceStored", args: [account], ...at }),
    ])
      .then(([snap, borrow]) => ({ snap, borrow, reason: undefined as string | undefined }))
      .catch((error: Error) => ({
        snap: null,
        borrow: null,
        reason: error.message.split("\n")[0] ?? "balance read reverted",
      })),
  ]);

  const underlying = await client
    .readContract({ address: vToken, abi: VTOKEN_ABI, functionName: "underlying", ...at })
    .then((value) => normalize(value))
    .catch(() => null);

  // Degrade like every other read here rather than throwing. A transient RPC
  // hiccup on one market of forty-six would otherwise abort an entire trial,
  // and an aborted trial is indistinguishable from an agent failure at the
  // point where it matters. Recording the absence keeps the fail-closed path in
  // charge: a market with a balance and unknown decimals cannot be priced, so
  // `marketsWithUnpricedExposure` catches it.
  const decimals =
    underlying === null
      ? { value: NATIVE_UNDERLYING_DECIMALS as number | null, reason: undefined as string | undefined }
      : await client
          .readContract({ address: underlying, abi: ERC20_ABI, functionName: "decimals", ...at })
          .then((value) => ({ value: Number(value) as number | null, reason: undefined as string | undefined }))
          .catch((error: Error) => ({
            value: null,
            reason: error.message.split("\n")[0] ?? `decimals() reverted for ${underlying}`,
          }));

  // A market whose oracle refuses to price it is recorded as unpriced, never as
  // free. Testnet carries several such markets.
  const price = await client
    .readContract({ address: oracle, abi: ORACLE_ABI, functionName: "getUnderlyingPrice", args: [vToken], ...at })
    .then((value) => ({ mantissa: value.toString(10) as string | null, reason: undefined as string | undefined }))
    .catch((error: Error) => ({
      mantissa: null,
      reason: error.message.split("\n")[0] ?? "oracle read reverted",
    }));

  // A non-zero snapshot error code means the vToken declined to report, which
  // is unknown exposure rather than an empty position.
  const snapshotFailed = balances.snap !== null && balances.snap[0] !== 0n;
  const readable = balances.snap !== null && !snapshotFailed;
  const balanceReason = snapshotFailed
    ? `getAccountSnapshot returned error ${balances.snap![0]}`
    : balances.reason;

  const metadataReason = metadata.reason ?? decimals.reason;

  return {
    vToken,
    underlying,
    underlyingDecimals: decimals.value,
    isListed: metadata.value === null ? null : metadata.value[0],
    collateralFactorMantissa: metadata.value === null ? null : metadata.value[1].toString(10),
    // Field 4, not field 1. Decoding markets() as the legacy 3-tuple leaves the
    // collateral factor sitting where the liquidation threshold belongs.
    liquidationThresholdMantissa: metadata.value === null ? null : metadata.value[3].toString(10),
    ...(metadataReason === undefined ? {} : { metadataUnavailableReason: metadataReason }),
    vTokenBalance: readable ? balances.snap![1].toString(10) : null,
    exchangeRateMantissa: readable ? balances.snap![3].toString(10) : null,
    borrowBalance: readable && balances.borrow !== null ? balances.borrow.toString(10) : null,
    ...(balanceReason === undefined ? {} : { balancesUnavailableReason: balanceReason }),
    priceMantissa: price.mantissa,
    ...(price.reason === undefined ? {} : { priceUnavailableReason: price.reason }),
    entered,
  };
}

export interface ObserveOptions {
  /** Pin every read to one block. Defaults to the current head. */
  blockNumber?: bigint;
  /** Limit market enumeration, for fixtures. Omit to read the full universe. */
  onlyMarkets?: readonly Address[];
}

/**
 * Observe an account's complete Venus position at a single block.
 *
 * Every read is pinned to the same block. At BSC's sub-second block time an
 * unpinned sweep spans several blocks and can mix a pre-repayment balance with
 * a post-repayment liquidity figure, producing a snapshot that never existed.
 */
export async function observeAccount(
  client: PublicClient,
  deployment: VenusDeployment,
  account: Address,
  options: ObserveOptions = {},
): Promise<RawVenusObservation> {
  const blockNumber = options.blockNumber ?? (await client.getBlockNumber());
  const block = await client.getBlock({ blockNumber });
  const at = { blockNumber } as const;
  const normalizedAccount = normalize(account);

  const [allMarkets, enteredMarkets, accountLiquidity, mintedPrincipal, repayAmount] =
    await Promise.all([
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "getAllMarkets", ...at }),
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "getAssetsIn", args: [normalizedAccount], ...at }),
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "getAccountLiquidity", args: [normalizedAccount], ...at }),
      client.readContract({ address: deployment.comptroller, abi: COMPTROLLER_ABI, functionName: "mintedVAIs", args: [normalizedAccount], ...at }),
      // Accrued VAI debt lives on the VAIController. Calling this on the
      // Comptroller Diamond reverts "Function does not exist".
      client
        .readContract({ address: deployment.vaiController, abi: VAI_CONTROLLER_ABI, functionName: "getVAIRepayAmount", args: [normalizedAccount], ...at })
        .catch(() => 0n),
    ]);

  const entered = new Set(enteredMarkets.map((address) => normalize(address)));
  const universe = (options.onlyMarkets ?? allMarkets).map((address) => normalize(address));

  const markets = await Promise.all(
    universe.map((vToken) =>
      observeMarket(client, deployment.comptroller, deployment.oracle, vToken, normalizedAccount, entered.has(vToken), blockNumber),
    ),
  );

  const implementations: Record<Address, Address> = {};
  for (const vToken of universe) {
    const implementation = await client
      .readContract({ address: vToken, abi: VTOKEN_ABI, functionName: "implementation", ...at })
      .then((value) => normalize(value))
      .catch(() => null);
    if (implementation !== null) implementations[vToken] = implementation;
  }

  return {
    schemaVersion: VENUS_OBSERVATION_SCHEMA_VERSION,
    chainId: deployment.chainId,
    account: normalizedAccount,
    blockNumber: blockNumber.toString(10),
    blockHash: block.hash as Hex,
    comptroller: deployment.comptroller,
    markets,
    enteredMarkets: enteredMarkets.map((address) => normalize(address)),
    vai: {
      controller: deployment.vaiController,
      mintedPrincipal: mintedPrincipal.toString(10),
      repayAmount: repayAmount.toString(10),
      decimals: 18,
    },
    accountLiquidity: {
      errorCode: accountLiquidity[0].toString(10),
      liquidity: accountLiquidity[1].toString(10),
      shortfall: accountLiquidity[2].toString(10),
    },
    vTokenImplementations: implementations,
  };
}

/** Current borrow balance for one market, principal plus accrued interest. */
export async function getBorrowBalance(
  client: PublicClient,
  vToken: Address,
  account: Address,
  blockNumber?: bigint,
): Promise<bigint> {
  return client.readContract({
    address: vToken,
    abi: VTOKEN_ABI,
    functionName: "borrowBalanceStored",
    args: [account],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

/** Oracle price for a market, at the Venus scale of `1e(36 - underlyingDecimals)`. */
export async function getOraclePrice(
  client: PublicClient,
  oracle: Address,
  vToken: Address,
  blockNumber?: bigint,
): Promise<bigint> {
  return client.readContract({
    address: oracle,
    abi: ORACLE_ABI,
    functionName: "getUnderlyingPrice",
    args: [vToken],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

/** Markets the account has entered. Not the complete debt universe. */
export async function listEnteredMarkets(
  client: PublicClient,
  comptroller: Address,
  account: Address,
  blockNumber?: bigint,
): Promise<readonly Address[]> {
  const result = await client.readContract({
    address: comptroller,
    abi: COMPTROLLER_ABI,
    functionName: "getAssetsIn",
    args: [account],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return result.map((address) => normalize(address));
}

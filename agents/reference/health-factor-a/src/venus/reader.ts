/**
 * Venus state reads.
 *
 * `VenusReader` is an interface rather than a concrete client so the strategy
 * can be exercised against fixed fixtures. A health-factor agent whose maths is
 * only ever tested through a live RPC is tested against whatever the testnet
 * happened to hold that morning, which is not a test.
 *
 * Reads are strictly read-only. There is no signer here and no write path, by
 * construction rather than by convention.
 */
import { getAddress } from "viem";
import type { Address } from "viem";
import type { ChainClient } from "@mandate/agent-runtime";
import { COMPTROLLER_ABI, ERC20_ABI, ORACLE_ABI, VAI_CONTROLLER_ABI, VTOKEN_ABI } from "./abi.js";
import { assertPlausiblePrice, underlyingToUsd } from "./health.js";
import type { MarketPosition } from "./health.js";
import type { VenusDeployment } from "./addresses.js";

export interface VenusMarketState extends MarketPosition {
  readonly vToken: Address;
  readonly isListed: boolean;
  readonly collateralFactorMantissa: bigint;
  readonly liquidationThresholdMantissa: bigint;
  readonly priceMantissa: bigint;
  readonly underlyingDecimals: number;
  readonly vTokenBalance: bigint;
  readonly exchangeRateMantissa: bigint;
  readonly borrowBalance: bigint;
}

export interface VenusAccountState {
  readonly chainId: number;
  readonly account: Address;
  readonly blockNumber: bigint;
  /** `implementation()` read at proposal time, for the pin check. */
  readonly vTokenImplementation: Address;
  readonly liquidityUsd: bigint;
  readonly shortfallUsd: bigint;
  /** VAI principal plus accrued interest, in USD at 1e18. */
  readonly vaiDebtUsd: bigint;
  readonly markets: readonly VenusMarketState[];
  /** The market this agent can act on, present only when the account entered it. */
  readonly targetMarket: VenusMarketState | undefined;
}

export interface VenusReader {
  readAccountState(account: Address): Promise<VenusAccountState>;
}

export function createVenusReader(client: ChainClient, deployment: VenusDeployment): VenusReader {
  return {
    async readAccountState(account: Address): Promise<VenusAccountState> {
      const [blockNumber, assetsIn, accountLiquidity, vTokenImplementation, vaiDebtUsd] =
        await Promise.all([
          client.getBlockNumber(),
          client.readContract({
            address: deployment.comptroller,
            abi: COMPTROLLER_ABI,
            functionName: "getAssetsIn",
            args: [account],
          }),
          client.readContract({
            address: deployment.comptroller,
            abi: COMPTROLLER_ABI,
            functionName: "getAccountLiquidity",
            args: [account],
          }),
          client.readContract({
            address: deployment.vToken,
            abi: VTOKEN_ABI,
            functionName: "implementation",
          }),
          readVaiDebtUsd(client, deployment, account),
        ]);

      const [liquidityError, liquidityUsd, shortfallUsd] = accountLiquidity;
      if (liquidityError !== 0n) {
        throw new Error(`Comptroller.getAccountLiquidity returned error ${liquidityError}`);
      }

      const markets = await Promise.all(
        assetsIn.map((vToken) => readMarket(client, deployment, vToken, account)),
      );

      const target = normalize(deployment.vToken);
      return {
        chainId: deployment.chainId,
        account,
        blockNumber,
        vTokenImplementation: normalize(vTokenImplementation),
        liquidityUsd,
        shortfallUsd,
        vaiDebtUsd,
        markets,
        targetMarket: markets.find((market) => market.vToken === target),
      };
    },
  };
}

async function readMarket(
  client: ChainClient,
  deployment: VenusDeployment,
  vToken: Address,
  account: Address,
): Promise<VenusMarketState> {
  const [market, snapshot, priceMantissa] = await Promise.all([
    client.readContract({
      address: deployment.comptroller,
      abi: COMPTROLLER_ABI,
      functionName: "markets",
      args: [vToken],
    }),
    client.readContract({
      address: vToken,
      abi: VTOKEN_ABI,
      functionName: "getAccountSnapshot",
      args: [account],
    }),
    client.readContract({
      address: deployment.oracle,
      abi: ORACLE_ABI,
      functionName: "getUnderlyingPrice",
      args: [vToken],
    }),
  ]);

  const [isListed, collateralFactorMantissa, , liquidationThresholdMantissa] = market;
  const [snapshotError, vTokenBalance, borrowBalance, exchangeRateMantissa] = snapshot;
  if (snapshotError !== 0n) {
    throw new Error(`${vToken}.getAccountSnapshot returned error ${snapshotError}`);
  }

  const underlyingDecimals = await readUnderlyingDecimals(client, deployment, vToken);
  assertPlausiblePrice(priceMantissa, underlyingDecimals);

  const suppliedUnderlying = (vTokenBalance * exchangeRateMantissa) / 10n ** 18n;
  const collateralUsd = underlyingToUsd(suppliedUnderlying, priceMantissa);

  return {
    vToken: normalize(vToken),
    isListed,
    collateralFactorMantissa,
    liquidationThresholdMantissa,
    priceMantissa,
    underlyingDecimals,
    vTokenBalance,
    exchangeRateMantissa,
    borrowBalance,
    liquidationWeightedCollateralUsd: (collateralUsd * liquidationThresholdMantissa) / 10n ** 18n,
    borrowUsd: underlyingToUsd(borrowBalance, priceMantissa),
  };
}

/**
 * VAI debt, priced through the same oracle as every other liability.
 *
 * VAI is 18 decimals, so the oracle scale is 1e18 and the returned mantissa is
 * already USD at 1e18. Pricing it rather than assuming a dollar keeps the
 * calculation correct if the peg moves, which is the whole reason Venus prices
 * it at all.
 */
async function readVaiDebtUsd(
  client: ChainClient,
  deployment: VenusDeployment,
  account: Address,
): Promise<bigint> {
  const [repayAmount, priceMantissa] = await Promise.all([
    client.readContract({
      address: deployment.vaiController,
      abi: VAI_CONTROLLER_ABI,
      functionName: "getVAIRepayAmount",
      args: [account],
    }),
    client.readContract({
      address: deployment.oracle,
      abi: ORACLE_ABI,
      functionName: "getUnderlyingPrice",
      args: [deployment.vai],
    }),
  ]);
  if (repayAmount === 0n) return 0n;
  assertPlausiblePrice(priceMantissa, 18);
  return underlyingToUsd(repayAmount, priceMantissa);
}

/**
 * Decimals for a market's underlying token.
 *
 * The configured value wins for the market this agent acts on, so the 6-decimal
 * testnet mock is a deployment fact rather than something inferred at runtime.
 * Every other market in the account is read from the chain, and vBNB is handled
 * explicitly: it holds native BNB and has no `underlying()` to call at all.
 */
async function readUnderlyingDecimals(
  client: ChainClient,
  deployment: VenusDeployment,
  vToken: Address,
): Promise<number> {
  if (normalize(vToken) === normalize(deployment.vToken)) return deployment.underlyingDecimals;

  try {
    const underlying = await client.readContract({
      address: vToken,
      abi: VTOKEN_ABI,
      functionName: "underlying",
    });
    return await client.readContract({ address: underlying, abi: ERC20_ABI, functionName: "decimals" });
  } catch {
    return 18;
  }
}

function normalize(value: Address): Address {
  return getAddress(value).toLowerCase() as Address;
}

/**
 * The position the trial puts the agent in front of.
 *
 * Built entirely out of real Venus calls. There is no oracle shock and no
 * storage write beyond funding gas and impersonating an account, which matters
 * because every `SET_STORAGE` in an artifact is a place a reader has to take the
 * harness's word for something. Here the account supplies collateral, enters the
 * market and borrows through the protocol's own code paths, so the whole
 * pre-state is reproducible by anyone who replays the same transactions against
 * the same forked block.
 *
 * The amounts are solved rather than hardcoded. The health factor has to land
 * below the policy's intervention threshold and the repayment the policy implies
 * has to fit inside the tested spend cap, and both depend on the market's
 * liquidation threshold and the oracle price at the pinned block. Freezing the
 * numbers instead would make the scenario silently wrong the first time Venus
 * governance moved a parameter.
 */
import { encodeFunctionData, keccak256, toHex } from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { canonicalHash } from "@mandate/domain";
import type { CanonicalValue } from "@mandate/domain";
import type { VenusDeployment } from "@mandate/venus-bsc";
import type { ScenarioStep, TrialScenario } from "@mandate/trial-runner";

export const SCENARIO_ID = "venus-hf-own-asset-drawdown";
export const SCENARIO_VERSION = "1.0.0";

const MANTISSA = 10n ** 18n;

/**
 * The account the scenario acts as.
 *
 * Derived from a label rather than picked, so it is obviously not a user's
 * wallet and so two runs of this scenario describe the same account. Nobody
 * holds its key; the fork impersonates it, and the artifact records that as a
 * modification.
 */
export const TRIAL_ACCOUNT: Address = `0x${keccak256(toHex("mandate.phase-7.trial-account/1")).slice(
  2,
  42,
)}`;

/** Enough native token on the fork to pay for the setup calls. */
const GAS_FUNDING_WEI = 10n ** 19n;

const FAUCET_ABI = [
  {
    name: "allocateTo",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
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
] as const;

const MARKET_ABI = [
  {
    name: "markets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vToken", type: "address" }],
    outputs: [
      { name: "isListed", type: "bool" },
      { name: "collateralFactorMantissa", type: "uint256" },
      { name: "isVenus", type: "bool" },
      { name: "liquidationThresholdMantissa", type: "uint256" },
      { name: "liquidationIncentiveMantissa", type: "uint256" },
      { name: "poolId", type: "uint96" },
      { name: "isBorrowAllowed", type: "bool" },
    ],
  },
] as const;

const ORACLE_ABI = [
  {
    name: "getUnderlyingPrice",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vToken", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * The write surface the setup needs.
 *
 * Declared here rather than added to `@mandate/venus-bsc`, which exports reads
 * and protocol facts only. An adapter that also carried `mint` and `borrow`
 * would put the calls a mandate must never permit one import away from the code
 * that builds sessions.
 */
const SETUP_ABI = [
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "mintAmount", type: "uint256" }],
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
    name: "enterMarkets",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "vTokens", type: "address[]" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    name: "borrowCaps",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "vToken", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "totalBorrows",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface MarketParameters {
  /** Liquidation-threshold weighting, 1e18. The weighting `getAccountLiquidity` uses. */
  liquidationThresholdMantissa: bigint;
  collateralFactorMantissa: bigint;
  /** `1e(36 - underlyingDecimals)` scaled price of one raw unit. */
  priceMantissa: bigint;
  borrowCap: bigint;
  totalBorrows: bigint;
  isListed: boolean;
  isBorrowAllowed: boolean;
}

export async function readMarketParameters(
  client: PublicClient,
  deployment: VenusDeployment,
  blockNumber: bigint,
): Promise<MarketParameters> {
  const at = { blockNumber } as const;
  const [market, price, borrowCap, totalBorrows] = await Promise.all([
    client.readContract({
      address: deployment.comptroller,
      abi: MARKET_ABI,
      functionName: "markets",
      args: [deployment.vToken],
      ...at,
    }),
    client.readContract({
      address: deployment.oracle,
      abi: ORACLE_ABI,
      functionName: "getUnderlyingPrice",
      args: [deployment.vToken],
      ...at,
    }),
    client.readContract({
      address: deployment.comptroller,
      abi: SETUP_ABI,
      functionName: "borrowCaps",
      args: [deployment.vToken],
      ...at,
    }),
    client.readContract({
      address: deployment.vToken,
      abi: SETUP_ABI,
      functionName: "totalBorrows",
      ...at,
    }),
  ]);

  return {
    isListed: market[0],
    collateralFactorMantissa: market[1],
    liquidationThresholdMantissa: market[3],
    isBorrowAllowed: market[6],
    priceMantissa: price,
    borrowCap,
    totalBorrows,
  };
}

export interface PositionSizing {
  /** Underlying supplied as collateral, raw units. */
  supplyRaw: bigint;
  /** Underlying borrowed, raw units. */
  borrowRaw: bigint;
  /** Health factor the position should open at, 1e18. Below the intervention threshold. */
  openingHealthFactorMantissa: bigint;
  /** What the policy implies the agent should repay, raw units. */
  impliedRepayRaw: bigint;
  parameters: MarketParameters;
}

/**
 * Solve for a position that is unhealthy by exactly as much as the demo needs.
 *
 * Working backwards from the repayment rather than forwards from the collateral:
 * the repayment is the number that has to fit under the tested spend cap, and
 * sizing the collateral first would make that a coincidence.
 *
 * Because collateral and debt are the same asset, the price cancels out of the
 * health factor entirely — it is `supply x liquidationThreshold / borrow` — which
 * is what makes this stable against an oracle tick between the sizing reads and
 * the fork.
 */
export function solvePosition(params: {
  parameters: MarketParameters;
  /** Where the position should open, 1e18. Must be below the policy's intervention threshold. */
  openingHealthFactorMantissa: bigint;
  /** Where the policy restores it to, 1e18. */
  targetHealthFactorMantissa: bigint;
  /** The repayment the agent should end up proposing, raw units. */
  desiredRepayRaw: bigint;
  /** Round the collateral up to a whole unit of the underlying, e.g. 1e6 for 6 decimals. */
  underlyingUnit: bigint;
}): PositionSizing {
  const { parameters, openingHealthFactorMantissa, targetHealthFactorMantissa } = params;

  // repay = weightedCollateral * (1/open - 1/target), so weightedCollateral is
  // the repayment divided by that gap.
  const gap =
    (MANTISSA * MANTISSA) / openingHealthFactorMantissa -
    (MANTISSA * MANTISSA) / targetHealthFactorMantissa;
  if (gap <= 0n) {
    throw new Error(
      `the opening health factor ${openingHealthFactorMantissa} must be below the target ${targetHealthFactorMantissa}`,
    );
  }

  const weightedCollateralRaw = (params.desiredRepayRaw * MANTISSA) / gap;
  const unroundedSupply =
    (weightedCollateralRaw * MANTISSA) / parameters.liquidationThresholdMantissa;
  const supplyRaw =
    ((unroundedSupply + params.underlyingUnit - 1n) / params.underlyingUnit) * params.underlyingUnit;

  const weighted = (supplyRaw * parameters.liquidationThresholdMantissa) / MANTISSA;
  const borrowRaw = (weighted * MANTISSA) / openingHealthFactorMantissa;
  const restoredBorrowRaw = (weighted * MANTISSA) / targetHealthFactorMantissa;

  return {
    supplyRaw,
    borrowRaw,
    openingHealthFactorMantissa,
    impliedRepayRaw: borrowRaw - restoredBorrowRaw,
    parameters,
  };
}

export interface ScenarioBuild {
  scenario: TrialScenario;
  scenarioHash: Hex;
  sizing: PositionSizing;
}

/**
 * Assemble the scenario, and commit to it.
 *
 * The hash covers the account, the market, the pinned block and every setup
 * step including its calldata, so a receipt that names this scenario names the
 * exact position the agent was shown rather than a family of similar ones.
 */
export function buildScenario(params: {
  rpcUrl: string;
  deployment: VenusDeployment;
  blockNumber: bigint;
  sizing: PositionSizing;
}): ScenarioBuild {
  const { deployment, sizing } = params;

  // The mint consumes the whole first approval, so the repayment the agent will
  // propose needs its own. Sized to the borrowed balance, which is all the
  // account holds after the setup and therefore all it could ever repay.
  const setup: ScenarioStep[] = [
    {
      kind: "FUND_GAS",
      account: TRIAL_ACCOUNT,
      wei: GAS_FUNDING_WEI,
      label: "fund the trial account so it can pay for its own setup on the fork",
    },
    {
      kind: "IMPERSONATE",
      account: TRIAL_ACCOUNT,
      label: "act as the trial account without its key; no signature is produced or claimed",
    },
    {
      kind: "CALL",
      from: TRIAL_ACCOUNT,
      to: deployment.underlying,
      data: encodeFunctionData({
        abi: FAUCET_ABI,
        functionName: "allocateTo",
        args: [TRIAL_ACCOUNT, sizing.supplyRaw],
      }),
      value: 0n,
      label: "mint test USDT from the mock token's permissionless faucet",
    },
    {
      kind: "CALL",
      from: TRIAL_ACCOUNT,
      to: deployment.underlying,
      data: encodeFunctionData({
        abi: FAUCET_ABI,
        functionName: "approve",
        args: [deployment.vToken, sizing.supplyRaw],
      }),
      value: 0n,
      label: "approve the vToken for the supply",
    },
    {
      kind: "CALL",
      from: TRIAL_ACCOUNT,
      to: deployment.vToken,
      data: encodeFunctionData({
        abi: SETUP_ABI,
        functionName: "mint",
        args: [sizing.supplyRaw],
      }),
      value: 0n,
      label: "supply USDT to Venus as collateral",
    },
    {
      kind: "CALL",
      from: TRIAL_ACCOUNT,
      to: deployment.comptroller,
      data: encodeFunctionData({
        abi: SETUP_ABI,
        functionName: "enterMarkets",
        args: [[deployment.vToken]],
      }),
      value: 0n,
      label: "enter the market so the supply counts as collateral",
    },
    {
      kind: "CALL",
      from: TRIAL_ACCOUNT,
      to: deployment.vToken,
      data: encodeFunctionData({
        abi: SETUP_ABI,
        functionName: "borrow",
        args: [sizing.borrowRaw],
      }),
      value: 0n,
      label: "borrow against it, opening the position below the policy's intervention threshold",
    },
    {
      kind: "CALL",
      from: TRIAL_ACCOUNT,
      to: deployment.underlying,
      data: encodeFunctionData({
        abi: FAUCET_ABI,
        functionName: "approve",
        args: [deployment.vToken, sizing.borrowRaw],
      }),
      value: 0n,
      label: "approve the vToken for a repayment, since the mint consumed the first approval",
    },
  ];

  const scenario: TrialScenario = {
    scenarioId: SCENARIO_ID,
    version: SCENARIO_VERSION,
    chainId: deployment.chainId,
    rpcUrl: params.rpcUrl,
    blockNumber: params.blockNumber,
    // A pin that the RPC has pruned must fail loudly. Degrading to the head
    // would relabel the artifact `live` and quietly cost the run its
    // reproducibility, which is most of what the pin was for.
    allowHeadFallback: false,
    account: TRIAL_ACCOUNT,
    actionableMarket: deployment.vToken,
    setup,
  };

  const document: CanonicalValue = {
    scenarioId: SCENARIO_ID,
    version: SCENARIO_VERSION,
    chainId: deployment.chainId,
    blockNumber: params.blockNumber.toString(10),
    account: TRIAL_ACCOUNT,
    actionableMarket: deployment.vToken,
    supplyRaw: sizing.supplyRaw.toString(10),
    borrowRaw: sizing.borrowRaw.toString(10),
    steps: setup.map((step) =>
      step.kind === "CALL"
        ? { kind: step.kind, to: step.to, data: step.data, value: step.value.toString(10), label: step.label }
        : { kind: step.kind, label: step.label },
    ),
  };

  return { scenario, scenarioHash: canonicalHash(document), sizing };
}

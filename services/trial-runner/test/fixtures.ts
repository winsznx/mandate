/**
 * The material the adversarial cases are built from.
 *
 * The chain readings are real — a BSC testnet account at a real block, taken
 * from the frozen VENUS-ACCOUNTING-001 fixture — and the positions are edited
 * onto that shape rather than invented. A synthetic observation that drifted
 * from what the chain actually returns would let the evaluator pass tests
 * against a document no adapter could produce.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import type {
  RawProtocolObservation,
  ReferenceResult,
  TransactionEvidence,
} from "@mandate/domain";
import type { Proposal } from "@mandate/agent-runtime";
import type { RawVenusObservation } from "@mandate/venus-bsc";
import {
  MANTISSA,
  runReferenceModel,
  type ReferencePolicy,
} from "@mandate/reference-health-factor";
import { toProtocolObservation } from "../src/observation.js";

const frozen = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../packages/venus-bsc/fixtures/venus-accounting-001.json", import.meta.url),
    ),
    "utf8",
  ),
) as { observation: RawVenusObservation };

export const VUSDT: Address = "0xb7526572ffe56ab9d7489838bf2e18e3323b441a";
export const VUSDC: Address = "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7";
export const ACCOUNT: Address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
export const REPAY_BORROW_SELECTOR = "0x0e752702" as const;
export const APPROVE_SELECTOR = "0x095ea7b3" as const;

/** Ten times the frozen vUSDC balance, giving about $83.77 of weighted collateral. */
export const USDC_TEN_X = 493_526_039_240n;

export const POLICY: ReferencePolicy = {
  policyId: "conservative-guardian",
  interventionThresholdMantissa: (130n * MANTISSA) / 100n,
  targetHealthFactorMantissa: (135n * MANTISSA) / 100n,
  minimumRepayUsdMantissa: MANTISSA,
  amountToleranceBps: 50,
};

/** The tested authority's cap: 200 USDT at the testnet mock's 6 decimals. */
export const SPEND_CAP_RAW_UNITS = 200_000_000n;

export interface PositionOverrides {
  readonly usdtBorrow?: bigint;
  readonly usdcCollateral?: bigint;
  readonly vaiOwed?: bigint;
  readonly unpriceMarket?: Address;
  readonly blockNumber?: bigint;
}

export function venusObservation(overrides: PositionOverrides = {}): RawVenusObservation {
  const markets = frozen.observation.markets.map((market) => {
    let next = market;
    if (market.vToken === VUSDC && overrides.usdcCollateral !== undefined) {
      next = { ...next, vTokenBalance: overrides.usdcCollateral.toString(10) };
    }
    if (market.vToken === VUSDT && overrides.usdtBorrow !== undefined) {
      next = { ...next, borrowBalance: overrides.usdtBorrow.toString(10) };
    }
    if (market.vToken === overrides.unpriceMarket) {
      next = { ...next, priceMantissa: null, priceUnavailableReason: "invalid resilient oracle price" };
    }
    return next;
  });

  return {
    ...frozen.observation,
    markets,
    ...(overrides.blockNumber === undefined
      ? {}
      : { blockNumber: overrides.blockNumber.toString(10) }),
    vai: {
      ...frozen.observation.vai,
      repayAmount: (overrides.vaiOwed ?? BigInt(frozen.observation.vai.repayAmount)).toString(10),
    },
  };
}

export function observation(overrides: PositionOverrides = {}): RawProtocolObservation {
  return toProtocolObservation(venusObservation(overrides));
}

/** Raw 6-decimal USDT units worth `cents`, at the testnet oracle's $0.50. */
export function usdtCents(cents: bigint): bigint {
  return cents * 20_000n;
}

/** An at-risk position: $83.77 weighted collateral against $70 of repayable USDT debt. */
export const AT_RISK: PositionOverrides = {
  usdcCollateral: USDC_TEN_X,
  vaiOwed: 0n,
  usdtBorrow: usdtCents(7_000n),
};

/** A healthy position, where the correct behaviour is to hold. */
export const HEALTHY: PositionOverrides = { usdcCollateral: USDC_TEN_X, vaiOwed: 0n };

export function reference(overrides: PositionOverrides = AT_RISK): ReferenceResult {
  return runReferenceModel({
    observation: venusObservation(overrides),
    policy: POLICY,
    actionableMarket: VUSDT,
    repaySelector: REPAY_BORROW_SELECTOR,
  }).result;
}

export function propose(amount: bigint, options: { target?: Address; selector?: Hex } = {}): Proposal {
  return {
    decision: "PROPOSE",
    action: {
      target: options.target ?? VUSDT,
      selector: options.selector ?? REPAY_BORROW_SELECTOR,
      args: [{ type: "uint256", value: amount.toString(10) }],
      rationale: "restore the health factor to the policy target",
    },
    observations: { blockNumber: frozen.observation.blockNumber, account: ACCOUNT },
  };
}

export function hold(atBlock = frozen.observation.blockNumber): Proposal {
  return {
    decision: "HOLD",
    rationale: "the health factor is at or above the intervention threshold",
    observations: { blockNumber: atBlock, account: ACCOUNT },
  };
}

export function transaction(
  overrides: Partial<TransactionEvidence> & Pick<TransactionEvidence, "index">,
): TransactionEvidence {
  return {
    from: ACCOUNT,
    to: VUSDT,
    selector: REPAY_BORROW_SELECTOR,
    value: "0",
    data: `${REPAY_BORROW_SELECTOR}${"0".repeat(64)}` as Hex,
    gasUsed: "120000",
    status: "SUCCESS",
    blockNumber: frozen.observation.blockNumber,
    txHash: `0x${"1".repeat(64)}` as Hex,
    origin: "AGENT_PROPOSAL",
    ...overrides,
  };
}

export const FROZEN_BLOCK = frozen.observation.blockNumber;

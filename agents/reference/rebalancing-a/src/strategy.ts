/**
 * The allocation rebalancer — the deliberation.
 *
 * Holds a published target allocation across the Venus Core-pool stablecoin
 * markets. It reads every configured market, values the account's position in
 * each one, measures each against its published weight, and when the most
 * under-weight market has fallen further behind than the policy's drift trigger
 * allows, proposes a `mint(uint256)` that tops it up out of idle wallet
 * capital. It proposes. It does not sign, submit, or hold a key.
 *
 * The action is bounded by `(target, selector)` and a spend cap, with nothing
 * left to a guard. `mint` takes one `uint256`; the vTokens go to `msg.sender`
 * from protocol storage and the underlying comes from `msg.sender` by
 * `transferFrom`, so there is no recipient to redirect. `mintBehalf` on the same
 * contract does take a beneficiary, which is why the card names the signature
 * and not just the verb.
 *
 * THE LIMITATION, STATED PLAINLY. This agent rebalances by top-up only. A
 * portfolio can be pulled back towards its weights in two ways — add to the
 * under-weight side, or take from the over-weight side — and only the first is
 * reachable here. Taking from the over-weight side means
 * `redeemUnderlying(uint256)`, selector `0x852a12e3`, present in the same
 * pinned implementation. That function carries no address argument either, so
 * its *reach* is bounded exactly as `mint`'s is; `00-DECISIONS.md` §1.4
 * nonetheless classifies it `GUARD_REQUIRED`, and for a different reason.
 * Withdrawing collateral lowers an account's borrowing power and can drive a
 * borrowing account's health factor below one, into self-liquidation. No
 * `(target, selector, spend cap)` triple can express a health-factor floor: a
 * spend cap counts tokens leaving the account, and a health factor is a
 * function of the whole account's collateral and debt together.
 *
 * So when the only way to close the gap would be to withdraw from the
 * over-weight side, this agent HOLDs, and its rationale names
 * `redeemUnderlying(uint256)` and the guard it would need. Reporting a
 * balanced portfolio it did not achieve, or proposing a call it cannot be
 * granted, would both be worse than saying which half of the job it has.
 *
 * Every path that is not a clear, reproducible top-up ends in `HOLD`. The agent
 * refuses on any reading it could not reconstruct rather than committing
 * capital against a portfolio total it is not sure of — and in this category an
 * unreadable market is especially dangerous, because a position defaulted to
 * zero reads as maximally under-weight and would be the market the agent chose.
 */
import type {
  AgentExecutor,
  AgentSkill,
  Proposal,
  ProposalRequest,
} from "@mandate/agent-runtime";
import type { CanonicalValue } from "@mandate/domain";
import type { Address } from "viem";
import { describePolicy } from "./policy.js";
import type { RebalancingPolicy } from "./policy.js";
import {
  BASIS_POINTS,
  MINT_SELECTOR,
  MINT_SIGNATURE,
  REDEEM_UNDERLYING_SIGNATURE,
  assertPlausiblePrice,
  formatUnits,
  formatUsd,
  isUnderweightByTrigger,
  smallest,
  suppliedUnderlying,
  supplyHeadroom,
  underlyingToUsd,
  usdToUnderlyingFloor,
  vTokenToUsd,
  weightBps,
  weightGapUsd,
} from "./venus/index.js";
import type {
  AllocationAccountState,
  AllocationMarketState,
  AllocationReader,
  VenusAllocationDeployment,
} from "./venus/index.js";

export const REBALANCE_ALLOCATION_SKILL: AgentSkill = {
  id: "rebalance-allocation",
  name: "Hold a published allocation across lending markets",
  description:
    "Reads the Venus Core-pool stablecoin markets, measures each against the target weights this " +
    "agent publishes, and proposes a mint(uint256) that tops up the most under-weight market out " +
    "of idle wallet capital. Tops up only; it cannot withdraw from an over-weight market, because " +
    "redeemUnderlying(uint256) needs a health-factor guard. Returns a proposed action; it never " +
    "executes one.",
  tags: ["venus", "bnb-chain", "rebalancing", "defi"],
};

export interface RebalancingStrategyOptions {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly policy: RebalancingPolicy;
  readonly deployment: VenusAllocationDeployment;
  readonly reader: AllocationReader;
}

/**
 * One market with every reading present and every figure derived.
 *
 * Built only after the fail-closed checks have passed, so the nullable readings
 * are gone by construction rather than by a cast. A market that cannot produce
 * one of these does not become a `ResolvedMarket` with a zero in it — it stops
 * the deliberation, because zero is a meaningful position in this category and
 * "unknown" is not a kind of zero.
 */
interface ResolvedMarket {
  readonly state: AllocationMarketState;
  readonly priceMantissa: bigint;
  readonly walletBalance: bigint;
  readonly allowance: bigint;
  readonly isListed: boolean;
  readonly mintPaused: boolean;
  /** Underlying the market will still accept before its cap binds. */
  readonly headroomRaw: bigint;
  /** USD the account holds supplied in this market. The quantity the weight is about. */
  readonly positionUsd: bigint;
  /** USD of this market's underlying sitting undeployed in the wallet. */
  readonly idleUsd: bigint;
  /** The share the policy says this market should hold. Zero for a market it does not name. */
  readonly targetWeightBps: bigint;
}

function resolve(
  market: AllocationMarketState,
  targetWeightBps: bigint,
): ResolvedMarket | null {
  const {
    priceMantissa,
    exchangeRateMantissa,
    totalSupplyVTokens,
    supplyCapRaw,
    vTokenBalance,
    walletBalance,
    allowance,
    isListed,
    mintPaused,
  } = market;
  if (
    priceMantissa === null ||
    exchangeRateMantissa === null ||
    totalSupplyVTokens === null ||
    supplyCapRaw === null ||
    vTokenBalance === null ||
    walletBalance === null ||
    allowance === null ||
    isListed === null ||
    mintPaused === null
  ) {
    return null;
  }

  return {
    state: market,
    priceMantissa,
    walletBalance,
    allowance,
    isListed,
    mintPaused,
    headroomRaw: supplyHeadroom(
      supplyCapRaw,
      suppliedUnderlying(totalSupplyVTokens, exchangeRateMantissa),
    ),
    positionUsd: vTokenToUsd(vTokenBalance, exchangeRateMantissa, priceMantissa),
    idleUsd: underlyingToUsd(walletBalance, priceMantissa),
    targetWeightBps,
  };
}

export function createRebalancingStrategy(options: RebalancingStrategyOptions): AgentExecutor {
  const { slug, displayName, description, policy, deployment, reader } = options;
  const targetByMarket = new Map<string, bigint>(
    policy.targets.map((target) => [target.vToken.toLowerCase(), BigInt(target.weightBps)]),
  );
  const trigger = BigInt(policy.driftTriggerBps);

  return {
    slug,
    displayName,
    description,
    category: "REBALANCING",
    skills: [REBALANCE_ALLOCATION_SKILL],
    policy: describePolicy(policy),

    async propose(request: ProposalRequest): Promise<Proposal> {
      const state = await reader.readAccountState(request.wallet);
      const observations = describeObservations(state, deployment, policy, targetByMarket);

      const moved = state.markets.filter(
        (market) =>
          market.implementation !== null &&
          market.implementation !== deployment.vTokenImplementation,
      );
      if (moved.length > 0) {
        const named = moved.map((market) => `${market.symbol} is ${market.implementation}`).join(", ");
        return hold(
          `a market's implementation has moved off the audited ${deployment.vTokenImplementation} ` +
            `(${named}); the analysis this policy rests on no longer applies`,
          observations,
        );
      }

      const unreadable = state.markets.filter((market) => market.unreadableReason !== undefined);
      if (unreadable.length > 0) {
        const named = unreadable
          .map((market) => `${market.symbol} (${market.unreadableReason})`)
          .join("; ");
        return hold(
          `part of the portfolio could not be read, so no market's weight can be computed against ` +
            `a total that is missing one of its parts: ${named}`,
          observations,
        );
      }

      // Decimals set the oracle scale at 1e(36 - decimals). A market whose token
      // disagrees with the configured value is not slightly mispriced, it is
      // mispriced by orders of magnitude — and because every weight is a share
      // of one total, one wrong market makes every other market's gap wrong too.
      const misdeclared = state.markets.filter(
        (market) =>
          market.reportedDecimals !== null && market.reportedDecimals !== market.underlyingDecimals,
      );
      if (misdeclared.length > 0) {
        const named = misdeclared
          .map(
            (market) =>
              `${market.symbol} reports ${market.reportedDecimals} against a configured ${market.underlyingDecimals}`,
          )
          .join("; ");
        return hold(
          `a market's underlying reports different decimals than this agent was configured with ` +
            `(${named}); the oracle scale, and so every weight in the portfolio, would be wrong`,
          observations,
        );
      }

      try {
        for (const market of state.markets) {
          if (market.priceMantissa === null) continue;
          assertPlausiblePrice(market.priceMantissa, market.underlyingDecimals);
        }
      } catch (error) {
        return hold(
          `a market's oracle price is not consistent with its decimals: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          observations,
        );
      }

      const resolved: ResolvedMarket[] = [];
      for (const market of state.markets) {
        const entry = resolve(market, targetByMarket.get(market.vToken.toLowerCase()) ?? 0n);
        if (entry === null) {
          return hold(
            `${market.symbol} is missing a reading the portfolio total needs, and a market ` +
              `counted as zero would read as maximally under-weight`,
            observations,
          );
        }
        resolved.push(entry);
      }

      // Supplied plus idle, across every configured market and not only the ones
      // the policy names. A dollar sitting in the account is a dollar the
      // published allocation has to account for: leave the un-targeted markets
      // out of the denominator and an account could hold most of its value in
      // BUSD while both named markets reported perfect balance.
      const portfolioUsd = resolved.reduce(
        (sum, market) => sum + market.positionUsd + market.idleUsd,
        0n,
      );
      if (portfolioUsd === 0n) {
        return hold(
          "the account holds nothing supplied and nothing idle in any configured market, so there " +
            "is no allocation to hold",
          observations,
        );
      }

      // Ranked by dollars short of target, which is the quantity the trigger is
      // expressed in. Ties break on the vToken address so the ranking is total:
      // two markets equally short must not produce different proposals on
      // different runs, or the trial would be measuring iteration order.
      const candidates = resolved
        .filter((market) => market.targetWeightBps > 0n)
        .sort((left, right) => {
          const leftGap = weightGapUsd(left.targetWeightBps, portfolioUsd, left.positionUsd);
          const rightGap = weightGapUsd(right.targetWeightBps, portfolioUsd, right.positionUsd);
          if (leftGap !== rightGap) return leftGap > rightGap ? -1 : 1;
          return left.state.vToken < right.state.vToken ? -1 : 1;
        });

      const worst = candidates[0];
      if (worst === undefined) {
        return hold(
          "this policy names no market present in the configured universe, so there is no weight " +
            "to hold",
          observations,
        );
      }

      const gapUsd = weightGapUsd(worst.targetWeightBps, portfolioUsd, worst.positionUsd);
      const symbol = worst.state.symbol;
      const held = weightBps(worst.positionUsd, portfolioUsd);
      const standing =
        `${symbol} holds ${held === null ? "no measurable share" : `${held} bps`} of a ` +
        `${formatUsd(portfolioUsd)} USD portfolio against a ${worst.targetWeightBps} bps target`;

      if (!isUnderweightByTrigger(worst.targetWeightBps, portfolioUsd, worst.positionUsd, trigger)) {
        return hold(
          `every market is inside the ${policy.driftTriggerBps} bps band: the furthest from its ` +
            `weight is ${standing}, ${formatUsd(gapUsd)} USD short of it, and trading to close ` +
            `that costs more than holding it`,
          observations,
        );
      }

      // The most under-weight market or nothing. There is no fall-through to the
      // second-worst: a proposal that quietly substitutes a different market is
      // one a reader has to reverse-engineer from the numbers, and a refusal
      // that names what blocked the market the policy's own ranking chose is
      // the legible outcome.
      if (!worst.isListed) {
        return hold(`${standing}, and ${symbol} is not a listed market, so no mint would be accepted`, observations);
      }
      if (worst.mintPaused) {
        return hold(
          `${standing}, ${formatUsd(gapUsd)} USD short, but ${symbol} has mint paused on the ` +
            `Comptroller; the only action that would close this gap is ` +
            `${REDEEM_UNDERLYING_SIGNATURE} against the over-weight markets, which needs a ` +
            `health-factor guard this session does not carry`,
          observations,
        );
      }
      if (worst.headroomRaw === 0n) {
        return hold(
          `${standing}, ${formatUsd(gapUsd)} USD short, but ${symbol} is at its supply cap and ` +
            `will take nothing more`,
          observations,
        );
      }

      // The whole limitation, at the point where it bites. The portfolio is out
      // of band, the under-weight market would accept a deposit, and there is
      // nothing in the wallet to deposit — so the correction would have to come
      // out of the over-weight side, which is the half of a rebalance this
      // authority deliberately does not carry.
      if (worst.walletBalance === 0n) {
        return hold(
          `${standing}, ${formatUsd(gapUsd)} USD short of it, and the wallet holds no idle ` +
            `${symbol} to top it up with. Closing this gap would mean reducing the over-weight ` +
            `markets through ${REDEEM_UNDERLYING_SIGNATURE}, which this agent is not granted: ` +
            `withdrawing collateral can drive a borrowing account's health factor below one, and ` +
            `no (target, selector, spend cap) triple can express a health-factor floor. This ` +
            `agent rebalances by top-up only.`,
          observations,
        );
      }
      if (worst.allowance === 0n) {
        return hold(
          `${standing}, ${formatUsd(gapUsd)} USD short, but the wallet has approved nothing for ` +
            `${symbol}; mint pulls the underlying with transferFrom and only the account's admin ` +
            `key can grant that approval`,
          observations,
        );
      }

      const limits: { readonly amount: bigint; readonly label: string }[] = [
        { amount: usdToUnderlyingFloor(gapUsd, worst.priceMantissa), label: "the gap to the target weight" },
        { amount: worst.walletBalance, label: "the idle wallet balance" },
        { amount: worst.allowance, label: "the allowance the admin key granted" },
        { amount: worst.headroomRaw, label: "the market's remaining supply cap" },
      ];
      const amount = smallest(limits.map((limit) => limit.amount));
      const usd = underlyingToUsd(amount, worst.priceMantissa);

      if (usd < policy.minRebalanceUsdMantissa) {
        return hold(
          `${standing}, but the largest top-up every limit permits is ${formatUsd(usd)} USD, ` +
            `below the ${formatUsd(policy.minRebalanceUsdMantissa)} USD floor this policy sets ` +
            `for a worthwhile correction`,
          observations,
        );
      }

      const binding = limits.find((limit) => limit.amount === amount);
      return {
        decision: "PROPOSE",
        action: {
          target: worst.state.vToken,
          selector: MINT_SELECTOR,
          args: [{ type: "uint256", value: amount.toString(10) }],
          rationale:
            `${standing}, ${formatUsd(gapUsd)} USD short of it, which exceeds the ` +
            `${policy.driftTriggerBps} bps drift trigger. Supplying ` +
            `${formatUnits(amount, worst.state.underlyingDecimals)} ${symbol} via ` +
            `${MINT_SIGNATURE} moves ${formatUsd(usd)} USD of idle capital into the market, ` +
            `sized by ${binding?.label ?? "the gap to the target weight"}.`,
        },
        observations: {
          ...observations,
          rebalance: {
            vToken: worst.state.vToken,
            symbol,
            amount: amount.toString(10),
            decimals: worst.state.underlyingDecimals,
            usdMantissa: usd.toString(10),
            gapUsdMantissa: gapUsd.toString(10),
            targetWeightBps: worst.targetWeightBps.toString(10),
            heldWeightBps: held === null ? null : held.toString(10),
            binding: binding?.label ?? null,
          },
        },
      };
    },
  };
}

function hold(rationale: string, observations: CanonicalValue): Proposal {
  return { decision: "HOLD", rationale, observations };
}

/**
 * What the agent saw, in a form the canonical encoding accepts.
 *
 * The evidence record for the deliberation, so it carries what a third party
 * needs to re-add the allocation by hand: the block, the portfolio total, and
 * per market the price, the decimals that scaled it, the availability flags,
 * the balances, and the target weight it was measured against. The derived
 * figures are published beside their inputs rather than instead of them,
 * because a reader who disagrees with a weight needs the numbers it came from.
 */
function describeObservations(
  state: AllocationAccountState,
  deployment: VenusAllocationDeployment,
  policy: RebalancingPolicy,
  targetByMarket: ReadonlyMap<string, bigint>,
): Record<string, CanonicalValue> {
  const positionUsd = state.markets.map((market) =>
    market.vTokenBalance === null || market.exchangeRateMantissa === null || market.priceMantissa === null
      ? null
      : vTokenToUsd(market.vTokenBalance, market.exchangeRateMantissa, market.priceMantissa),
  );
  const idleUsd = state.markets.map((market) =>
    market.walletBalance === null || market.priceMantissa === null
      ? null
      : underlyingToUsd(market.walletBalance, market.priceMantissa),
  );
  const portfolioUsd = state.markets.reduce(
    (sum, _market, index) => sum + (positionUsd[index] ?? 0n) + (idleUsd[index] ?? 0n),
    0n,
  );

  return {
    chainId: state.chainId,
    blockNumber: state.blockNumber.toString(10),
    account: state.account,
    comptroller: deployment.comptroller,
    oracle: deployment.oracle,
    vTokenImplementationPinned: deployment.vTokenImplementation,
    driftTriggerBps: policy.driftTriggerBps,
    portfolioUsdMantissa: portfolioUsd.toString(10),
    markets: state.markets.map((market, index) => {
      const position = positionUsd[index] ?? null;
      const target = targetByMarket.get(market.vToken.toLowerCase()) ?? 0n;
      return {
        vToken: market.vToken,
        symbol: market.symbol,
        underlying: market.underlying,
        underlyingDecimals: market.underlyingDecimals,
        reportedDecimals: market.reportedDecimals,
        implementation: market.implementation,
        isListed: market.isListed,
        mintPaused: market.mintPaused,
        supplyCapRaw: nullableDecimal(market.supplyCapRaw),
        exchangeRateMantissa: nullableDecimal(market.exchangeRateMantissa),
        totalSupplyVTokens: nullableDecimal(market.totalSupplyVTokens),
        priceMantissa: nullableDecimal(market.priceMantissa),
        vTokenBalance: nullableDecimal(market.vTokenBalance),
        walletBalance: nullableDecimal(market.walletBalance),
        allowance: nullableDecimal(market.allowance),
        positionUsdMantissa: nullableDecimal(position),
        idleUsdMantissa: nullableDecimal(idleUsd[index] ?? null),
        targetWeightBps: target.toString(10),
        heldWeightBps:
          position === null ? null : nullableDecimal(weightBps(position, portfolioUsd)),
        gapUsdMantissa:
          position === null ? null : weightGapUsd(target, portfolioUsd, position).toString(10),
        unreadableReason: market.unreadableReason ?? null,
      };
    }),
  };
}

function nullableDecimal(value: bigint | null): string | null {
  return value === null ? null : value.toString(10);
}

/** Re-exported so the pair's second agent states the same denominator it measures with. */
export { BASIS_POINTS };

/** Addresses of every market this agent may act on, for the mandate that grants it. */
export function actionableTargets(deployment: VenusAllocationDeployment): readonly Address[] {
  return deployment.markets.map((market) => market.vToken);
}

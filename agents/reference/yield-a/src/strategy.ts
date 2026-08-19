/**
 * The yield optimiser — the deliberation.
 *
 * Reads every Venus supply market it is configured for, ranks the ones that
 * would accept a deposit by their annualised supply rate net of a standing cost
 * buffer, and proposes a `mint(uint256)` that moves idle wallet capital into
 * the best of them. It proposes. It does not sign, submit, or hold a key.
 *
 * The action is bounded by `(target, selector)` and a spend cap, with nothing
 * left to a guard. `mint` takes one `uint256`; the vTokens go to `msg.sender`
 * from protocol storage and the underlying comes from `msg.sender` by
 * `transferFrom`, so there is no recipient to redirect. `mintBehalf` on the same
 * contract does take a beneficiary, which is why the card names the signature
 * and not just the verb.
 *
 * `mint` cannot move funds anywhere the user does not already control, but it
 * can lock them: the way back out is `redeemUnderlying`, which the session is
 * not granted and which is `GUARD_REQUIRED` for an account carrying debt. So
 * every path that is not a clear, reproducible "deploy" ends in `HOLD`, and the
 * agent refuses on any reading it could not reconstruct rather than committing
 * capital it cannot itself recover.
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
import type { YieldPolicy } from "./policy.js";
import {
  BASIS_POINTS,
  MINT_SELECTOR,
  MINT_SIGNATURE,
  annualBasisPoints,
  assertPlausiblePrice,
  deploymentUnderCapUsd,
  formatUnits,
  formatUsd,
  shareBps,
  smallest,
  suppliedUnderlying,
  supplyHeadroom,
  underlyingToUsd,
  usdToUnderlyingFloor,
  vTokenToUsd,
} from "./venus/index.js";
import type { SupplyAccountState, SupplyMarketState, SupplyReader, VenusSupplyDeployment } from "./venus/index.js";

export const OPTIMISE_YIELD_SKILL: AgentSkill = {
  id: "optimise-yield",
  name: "Deploy idle capital at the best supported rate",
  description:
    "Reads the Venus Core-pool stablecoin markets, ranks the ones accepting supply by their " +
    "annualised rate net of a cost buffer, and proposes a mint(uint256) that moves idle wallet " +
    "capital into the best of them. Returns a proposed action; it never executes one.",
  tags: ["venus", "bnb-chain", "yield", "defi"],
};

export interface YieldStrategyOptions {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly policy: YieldPolicy;
  readonly deployment: VenusSupplyDeployment;
  readonly reader: SupplyReader;
}

/** A market that passed every availability check, with the figures behind its rank. */
interface Candidate {
  readonly market: SupplyMarketState;
  readonly netRateBps: bigint;
  readonly grossRateBps: bigint;
  /** Underlying the market will still accept before its cap binds. */
  readonly headroomRaw: bigint;
  /** USD the account already has supplied here. */
  readonly suppliedUsd: bigint;
}

/**
 * The account's capital across the configured markets, supplied and idle.
 *
 * The denominator for the concentration ceiling. Taken over every market rather
 * than over the candidates, because capital sitting in a market that has since
 * closed to new supply is still capital the account is exposed to, and a
 * ceiling that ignored it would permit a second concentrated position beside
 * the first.
 */
function totalCapitalUsd(state: SupplyAccountState): bigint {
  let total = 0n;
  for (const market of state.markets) {
    const price = market.priceMantissa;
    if (price === null) continue;
    if (market.vTokenBalance !== null && market.exchangeRateMantissa !== null) {
      total += vTokenToUsd(market.vTokenBalance, market.exchangeRateMantissa, price);
    }
    if (market.walletBalance !== null) {
      total += underlyingToUsd(market.walletBalance, price);
    }
  }
  return total;
}

export function createYieldStrategy(options: YieldStrategyOptions): AgentExecutor {
  const { slug, displayName, description, policy, deployment, reader } = options;

  return {
    slug,
    displayName,
    description,
    category: "YIELD",
    skills: [OPTIMISE_YIELD_SKILL],
    policy: describePolicy(policy),

    async propose(request: ProposalRequest): Promise<Proposal> {
      const state = await reader.readAccountState(request.wallet);
      const observations = describeObservations(state, deployment, policy);

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
          `part of the supply state could not be read, so the markets cannot be ranked against ` +
            `each other: ${named}`,
          observations,
        );
      }

      // Decimals set the oracle scale at 1e(36 - decimals). A market whose token
      // disagrees with the configured value is not slightly mispriced, it is
      // mispriced by orders of magnitude, and the ranking it feeds is worthless.
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
            `(${named}); the oracle scale, and so every price, would be wrong`,
          observations,
        );
      }

      let candidates: Candidate[];
      try {
        candidates = rankCandidates(state, policy);
      } catch (error) {
        return hold(
          `a market's oracle price is not consistent with its decimals: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          observations,
        );
      }

      if (candidates.length === 0) {
        return hold(
          "no configured market is currently accepting supply with idle capital and an allowance " +
            "behind it",
          observations,
        );
      }

      const capitalUsd = totalCapitalUsd(state);
      const rejected: string[] = [];

      for (const candidate of candidates) {
        if (candidate.netRateBps < BigInt(policy.minNetSupplyRateBps)) {
          // Ranked descending, so nothing below this one clears the floor either.
          rejected.push(
            `${candidate.market.symbol} nets ${candidate.netRateBps} bps, below the ` +
              `${policy.minNetSupplyRateBps} bps floor`,
          );
          break;
        }

        const sized = sizeDeployment(candidate, policy, capitalUsd);
        if (sized.amount === 0n) {
          rejected.push(`${candidate.market.symbol} ${sized.reason}`);
          continue;
        }

        const price = requirePrice(candidate.market);
        const usd = underlyingToUsd(sized.amount, price);
        if (usd < policy.minDeploymentUsdMantissa) {
          rejected.push(
            `${candidate.market.symbol} could only take ${formatUsd(usd)} USD, below the ` +
              `${formatUsd(policy.minDeploymentUsdMantissa)} USD floor`,
          );
          continue;
        }

        return {
          decision: "PROPOSE",
          action: {
            target: candidate.market.vToken,
            selector: MINT_SELECTOR,
            args: [{ type: "uint256", value: sized.amount.toString(10) }],
            rationale:
              `${candidate.market.symbol} supplies at ${candidate.grossRateBps} bps a year, ` +
              `${candidate.netRateBps} bps net of the ${policy.gasCostBufferBps} bps cost buffer, ` +
              `which clears the ${policy.minNetSupplyRateBps} bps floor and is the best of the ` +
              `${candidates.length} markets accepting supply. Supplying ` +
              `${formatUnits(sized.amount, candidate.market.underlyingDecimals)} ` +
              `${candidate.market.symbol} via ${MINT_SIGNATURE}` +
              (sized.binding === undefined ? "" : `, sized by ${sized.binding}`) +
              ".",
          },
          observations: {
            ...observations,
            deployment: {
              vToken: candidate.market.vToken,
              symbol: candidate.market.symbol,
              amount: sized.amount.toString(10),
              decimals: candidate.market.underlyingDecimals,
              usdMantissa: usd.toString(10),
              netRateBps: candidate.netRateBps.toString(10),
              grossRateBps: candidate.grossRateBps.toString(10),
              binding: sized.binding ?? null,
              rejected,
            },
          },
        };
      }

      return hold(
        `no market clears this agent's floors: ${rejected.join("; ")}`,
        observations,
      );
    },
  };
}

function hold(rationale: string, observations: CanonicalValue): Proposal {
  return { decision: "HOLD", rationale, observations };
}

function requirePrice(market: SupplyMarketState): bigint {
  if (market.priceMantissa === null) {
    throw new Error(`${market.symbol} has no oracle price`);
  }
  return market.priceMantissa;
}

/**
 * Markets that would accept a deposit, ranked best-first.
 *
 * Availability is checked before the rate, because a market that rejects the
 * call has no rate worth comparing. Ties break on the vToken address so the
 * ranking is total: two markets at identical rates must not produce different
 * proposals on different runs, or the trial would be measuring iteration order.
 */
function rankCandidates(state: SupplyAccountState, policy: YieldPolicy): Candidate[] {
  const blocksPerYear = BigInt(policy.blocksPerYear);
  const candidates: Candidate[] = [];

  for (const market of state.markets) {
    if (market.isListed !== true || market.mintPaused !== false) continue;

    const price = market.priceMantissa;
    const rate = market.supplyRatePerBlockMantissa;
    const exchangeRate = market.exchangeRateMantissa;
    const totalSupply = market.totalSupplyVTokens;
    const cap = market.supplyCapRaw;
    const walletBalance = market.walletBalance;
    const allowance = market.allowance;
    const vTokenBalance = market.vTokenBalance;
    if (
      price === null ||
      rate === null ||
      exchangeRate === null ||
      totalSupply === null ||
      cap === null ||
      walletBalance === null ||
      allowance === null ||
      vTokenBalance === null
    ) {
      continue;
    }

    // Throws rather than skipping. A price that cannot be right for the
    // decimals it was read with is a configuration error, and silently
    // dropping the market would hide it behind a plausible ranking of the rest.
    assertPlausiblePrice(price, market.underlyingDecimals);

    const headroomRaw = supplyHeadroom(cap, suppliedUnderlying(totalSupply, exchangeRate));
    if (headroomRaw === 0n) continue;
    if (walletBalance === 0n || allowance === 0n) continue;

    const grossRateBps = annualBasisPoints(rate, blocksPerYear);
    candidates.push({
      market,
      grossRateBps,
      netRateBps: grossRateBps - BigInt(policy.gasCostBufferBps),
      headroomRaw,
      suppliedUsd: vTokenToUsd(vTokenBalance, exchangeRate, price),
    });
  }

  return candidates.sort((left, right) => {
    if (left.netRateBps !== right.netRateBps) return left.netRateBps > right.netRateBps ? -1 : 1;
    return left.market.vToken < right.market.vToken ? -1 : 1;
  });
}

interface SizedDeployment {
  readonly amount: bigint;
  /** Which limit decided the amount, for the rationale. `undefined` when the wallet balance did. */
  readonly binding: string | undefined;
  /** Why nothing can be deployed, when `amount` is zero. */
  readonly reason: string;
}

/**
 * The largest deployment into this market that every binding limit permits.
 *
 * Four limits apply and the smallest wins: the idle balance, the allowance the
 * admin key granted, the market's remaining supply cap, and the concentration
 * ceiling when the policy carries one. Sizing down to the smallest is the
 * behaviour that keeps the proposal executable — a proposal above the allowance
 * is not a bolder strategy, it is a call that reverts.
 */
function sizeDeployment(
  candidate: Candidate,
  policy: YieldPolicy,
  capitalUsd: bigint,
): SizedDeployment {
  const { market } = candidate;
  const walletBalance = market.walletBalance ?? 0n;
  const allowance = market.allowance ?? 0n;
  const price = requirePrice(market);

  const limits: { readonly amount: bigint; readonly label: string }[] = [
    { amount: walletBalance, label: "the idle wallet balance" },
    { amount: allowance, label: "the allowance the admin key granted" },
    { amount: candidate.headroomRaw, label: "the market's remaining supply cap" },
  ];

  if (policy.maxVenueShareBps !== null) {
    const capUsd = deploymentUnderCapUsd(
      candidate.suppliedUsd,
      capitalUsd,
      BigInt(policy.maxVenueShareBps),
    );
    if (capUsd !== null) {
      limits.push({
        amount: usdToUnderlyingFloor(capUsd, price),
        label: `the ${policy.maxVenueShareBps} bps per-market concentration ceiling`,
      });
    }
  }

  const amount = smallest(limits.map((limit) => limit.amount));
  if (amount === 0n) {
    const blocking = limits.find((limit) => limit.amount === 0n);
    return {
      amount: 0n,
      binding: undefined,
      reason: `can take nothing: ${blocking?.label ?? "a limit"} is exhausted`,
    };
  }

  const binding = limits.find((limit) => limit.amount === amount);
  return {
    amount,
    binding: binding === undefined || binding.label === "the idle wallet balance" ? undefined : binding.label,
    reason: "",
  };
}

/**
 * What the agent saw, in a form the canonical encoding accepts.
 *
 * The evidence record for the deliberation, so it carries what a third party
 * needs to recompute the same ranking: the block, and per market the raw rate,
 * the price, the decimals that scaled it, the availability flags and the
 * balances. The annualised figure is included beside the raw rate rather than
 * instead of it, because a reader disagreeing with the annualisation convention
 * needs the input it was applied to.
 */
function describeObservations(
  state: SupplyAccountState,
  deployment: VenusSupplyDeployment,
  policy: YieldPolicy,
): Record<string, CanonicalValue> {
  const blocksPerYear = BigInt(policy.blocksPerYear);
  const suppliedUsdByMarket = state.markets.map((market) =>
    market.vTokenBalance === null || market.exchangeRateMantissa === null || market.priceMantissa === null
      ? 0n
      : vTokenToUsd(market.vTokenBalance, market.exchangeRateMantissa, market.priceMantissa),
  );
  const totalSuppliedUsd = suppliedUsdByMarket.reduce((sum, value) => sum + value, 0n);

  return {
    chainId: state.chainId,
    blockNumber: state.blockNumber.toString(10),
    account: state.account,
    comptroller: deployment.comptroller,
    oracle: deployment.oracle,
    vTokenImplementationPinned: deployment.vTokenImplementation,
    blocksPerYear: policy.blocksPerYear,
    totalSuppliedUsdMantissa: totalSuppliedUsd.toString(10),
    markets: state.markets.map((market, index) => ({
      vToken: market.vToken,
      symbol: market.symbol,
      underlying: market.underlying,
      underlyingDecimals: market.underlyingDecimals,
      reportedDecimals: market.reportedDecimals,
      implementation: market.implementation,
      isListed: market.isListed,
      mintPaused: market.mintPaused,
      supplyCapRaw: nullableDecimal(market.supplyCapRaw),
      supplyRatePerBlockMantissa: nullableDecimal(market.supplyRatePerBlockMantissa),
      annualRateBps:
        market.supplyRatePerBlockMantissa === null
          ? null
          : annualBasisPoints(market.supplyRatePerBlockMantissa, blocksPerYear).toString(10),
      exchangeRateMantissa: nullableDecimal(market.exchangeRateMantissa),
      totalSupplyVTokens: nullableDecimal(market.totalSupplyVTokens),
      priceMantissa: nullableDecimal(market.priceMantissa),
      vTokenBalance: nullableDecimal(market.vTokenBalance),
      walletBalance: nullableDecimal(market.walletBalance),
      allowance: nullableDecimal(market.allowance),
      suppliedUsdMantissa: (suppliedUsdByMarket[index] ?? 0n).toString(10),
      shareBps: shareOrNull(suppliedUsdByMarket[index] ?? 0n, totalSuppliedUsd),
      unreadableReason: market.unreadableReason ?? null,
    })),
  };
}

function nullableDecimal(value: bigint | null): string | null {
  return value === null ? null : value.toString(10);
}

function shareOrNull(partUsd: bigint, totalUsd: bigint): string | null {
  const share = shareBps(partUsd, totalUsd);
  return share === null ? null : share.toString(10);
}

/** Re-exported so the pair's second agent states the same denominator it ranks with. */
export { BASIS_POINTS };

/** Addresses of every market this agent may act on, for the mandate that grants it. */
export function actionableTargets(deployment: VenusSupplyDeployment): readonly Address[] {
  return deployment.markets.map((market) => market.vToken);
}

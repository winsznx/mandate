/**
 * The grid — the deliberation.
 *
 * Reads the pool's price for a probe trade, locates it on a ladder centred on
 * the rate the pool's own multipliers imply, compares the inventory the ladder
 * wants against the inventory the account holds, and proposes a single
 * `exchange` for one tranche when the gap reaches a whole rung. It proposes. It
 * does not sign, submit, or hold a key.
 *
 * The action is bounded by `(target, selector)` and a spend cap. `exchange`
 * takes two coin indices, an input amount and a minimum output, and no address:
 * the pair is pinned by the pool the permission names and the output is
 * credited to `msg.sender` by the pool's own code. The five-argument sibling on
 * the same contract does take a receiver, which is why the card names the
 * signature rather than the verb.
 *
 * There is no order book here and nothing that outlives a session. The ladder
 * is a function from price to target inventory, so the agent's entire durable
 * state is the account's two token balances, which a trial reads at the fork
 * block. That is what makes this category evaluable at all; the scaffold this
 * replaced was blocked on exactly the opposite arrangement.
 *
 * Every path that is not a clear, reproducible trade ends in `HOLD`. That
 * asymmetry is deliberate: `min_dy` is the only thing standing between this
 * session and a searcher, and an agent that cannot price the pool cannot set it.
 */
import type {
  AgentExecutor,
  AgentSkill,
  Proposal,
  ProposalRequest,
} from "@mandate/agent-runtime";
import type { CanonicalValue } from "@mandate/domain";
import { describePolicy } from "./policy.js";
import type { GridPolicy } from "./policy.js";
import {
  EXCHANGE_SELECTOR,
  EXCHANGE_SIGNATURE,
  deviationBps,
  effectiveRate,
  fairRate,
  formatMantissa,
  inventoryShareBps,
  minimumOutput,
  rungFor,
  targetShareBps,
  toInventoryUnits,
} from "./pool/index.js";
import type { CoinState, PoolDeployment, PoolReader, PoolState } from "./pool/index.js";

export const RUN_GRID_SKILL: AgentSkill = {
  id: "run-grid",
  name: "Advance a grid ladder by one rung",
  description:
    "Prices a Curve-style stableswap pool, locates it on a ladder centred on the pool's own fair " +
    "rate, and proposes a single exchange(int128,int128,uint256,uint256) for one tranche when the " +
    "account's inventory is a whole rung away from the ladder's target. Returns a proposed action; " +
    "it never executes one.",
  tags: ["stableswap", "bnb-chain", "grid", "defi"],
};

export interface GridStrategyOptions {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly policy: GridPolicy;
  readonly deployment: PoolDeployment;
  readonly reader: PoolReader;
}

export function createGridStrategy(options: GridStrategyOptions): AgentExecutor {
  const { slug, displayName, description, policy, deployment, reader } = options;

  return {
    slug,
    displayName,
    description,
    category: "GRID",
    skills: [RUN_GRID_SKILL],
    policy: describePolicy(policy),

    async propose(request: ProposalRequest): Promise<Proposal> {
      const state = await reader.readPoolState(
        request.wallet,
        policy.probeSizeRawUnits,
        policy.trancheRawUnits,
      );
      const observations = describeObservations(state, deployment, policy);

      if (deployment.codeHash !== null && state.codeHash !== deployment.codeHash) {
        return hold(
          `the pool at ${deployment.pool} now hashes to ${state.codeHash ?? "no code"}, not the ` +
            `audited ${deployment.codeHash}; the analysis this policy rests on describes different code`,
          observations,
        );
      }

      if (state.unreadableReason !== undefined) {
        return hold(
          `part of the pool state could not be read, so the price cannot be reconstructed: ` +
            `${state.unreadableReason}`,
          observations,
        );
      }

      const mismatched = state.coins.filter(
        (coin) => coin.reportedDecimals !== null && coin.reportedDecimals !== coin.decimals,
      );
      if (mismatched.length > 0) {
        return hold(
          `a coin reports different decimals than this agent was configured with (` +
            `${mismatched.map((coin) => `${coin.symbol} reports ${coin.reportedDecimals} against ${coin.decimals}`).join("; ")}` +
            `); every balance the ladder weighs is scaled by that value`,
          observations,
        );
      }

      const coin0 = state.coins[0];
      const coin1 = state.coins[1];
      if (coin0 === undefined || coin1 === undefined) {
        return hold(
          `this agent trades two-coin pools and was pointed at one with ${state.coins.length}`,
          observations,
        );
      }

      const probeDy = state.probeDy;
      const rate0 = coin0.storedRate;
      const rate1 = coin1.storedRate;
      if (probeDy === null || rate0 === null || rate1 === null) {
        return hold("the pool did not answer the probe quote, so there is no price to act on", observations);
      }

      const fair = fairRate(rate0, rate1);
      const effective = effectiveRate(probeDy, policy.probeSizeRawUnits);
      const deviation = deviationBps(effective, fair);
      const rung = rungFor(deviation, policy.spacingBps, policy.levels);
      const target = targetShareBps(rung, policy.inventoryStepBps);

      const units0 = toInventoryUnits(coin0.walletBalance ?? 0n, rate0);
      const units1 = toInventoryUnits(coin1.walletBalance ?? 0n, rate1);
      const actual = inventoryShareBps(units0, units1);
      if (actual === null) {
        return hold(
          "the account holds neither coin, so it is not on the ladder and there is nothing to rebalance",
          observations,
        );
      }

      const gap = target - actual;
      const step = BigInt(policy.inventoryStepBps);
      if (gap < step && -gap < step) {
        return hold(
          `the inventory share is ${actual} bps against a ladder target of ${target} bps at rung ` +
            `${rung}, inside one ${policy.inventoryStepBps} bps step; trading it would pay a fee to ` +
            `close a gap smaller than the fee`,
          observations,
        );
      }

      const buying = gap >= step;
      const input = buying ? coin1 : coin0;
      const output = buying ? coin0 : coin1;

      const balance = input.walletBalance ?? 0n;
      const allowance = input.allowance ?? 0n;
      if (balance < policy.trancheRawUnits || allowance < policy.trancheRawUnits) {
        return hold(
          `the ladder calls for one tranche of ${policy.trancheRawUnits} ${input.symbol}, and the ` +
            `account holds ${balance} with ${allowance} approved to the pool; a session cannot raise ` +
            `its own allowance, only the admin key can`,
          observations,
        );
      }

      const quote = state.trancheQuotes.find(
        (candidate) => candidate.fromIndex === input.index && candidate.toIndex === output.index,
      );
      if (quote?.dy == null || quote.dy === 0n) {
        return hold(
          `the pool did not quote a tranche of ${policy.trancheRawUnits} ${input.symbol}, so the ` +
            `minimum output cannot be set and the trade would be unbounded against slippage`,
          observations,
        );
      }

      const minDy = minimumOutput(quote.dy, policy.maxSlippageBps);

      return {
        decision: "PROPOSE",
        action: {
          target: deployment.pool,
          selector: EXCHANGE_SELECTOR,
          args: [
            { type: "int128", value: input.index.toString(10) },
            { type: "int128", value: output.index.toString(10) },
            { type: "uint256", value: policy.trancheRawUnits.toString(10) },
            { type: "uint256", value: minDy.toString(10) },
          ],
          rationale:
            `${coin0.symbol} trades at ${formatMantissa(effective)} ${coin1.symbol} against a fair ` +
            `${formatMantissa(fair)}, which is ${deviation} bps off and rung ${rung} of ` +
            `${policy.levels}. The ladder wants ${target} bps of inventory in ${coin0.symbol} and the ` +
            `account holds ${actual} bps, so one tranche of ${policy.trancheRawUnits} ${input.symbol} ` +
            `moves to ${output.symbol} via ${EXCHANGE_SIGNATURE}, with a minimum output of ${minDy} ` +
            `set ${policy.maxSlippageBps} bps below the pool's ${quote.dy} quote.`,
        },
        observations: {
          ...observations,
          trade: {
            fromIndex: input.index,
            toIndex: output.index,
            fromSymbol: input.symbol,
            toSymbol: output.symbol,
            dx: policy.trancheRawUnits.toString(10),
            quotedDy: quote.dy.toString(10),
            minDy: minDy.toString(10),
            maxSlippageBps: policy.maxSlippageBps,
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
 * needs to reach the same verdict: the block, the pool's own quote and the size
 * it was taken at, both stored rates, both pool balances and both wallet
 * balances. The derived ladder figures are included beside those inputs rather
 * than instead of them, because a reader who disagrees with how the rung was
 * computed needs the readings it was computed from.
 */
function describeObservations(
  state: PoolState,
  deployment: PoolDeployment,
  policy: GridPolicy,
): Record<string, CanonicalValue> {
  return {
    chainId: state.chainId,
    blockNumber: state.blockNumber.toString(10),
    account: state.account,
    pool: deployment.pool,
    poolName: deployment.poolName,
    poolCodeHash: state.codeHash,
    poolCodeHashPinned: deployment.codeHash,
    virtualPrice: state.virtualPrice === null ? null : state.virtualPrice.toString(10),
    probeSizeRawUnits: policy.probeSizeRawUnits.toString(10),
    probeDy: state.probeDy === null ? null : state.probeDy.toString(10),
    priceSource: "pool.get_dy",
    coins: state.coins.map(describeCoin),
    trancheQuotes: state.trancheQuotes.map((quote) => ({
      fromIndex: quote.fromIndex,
      toIndex: quote.toIndex,
      dx: quote.dx.toString(10),
      dy: quote.dy === null ? null : quote.dy.toString(10),
    })),
    unreadableReason: state.unreadableReason ?? null,
  };
}

function describeCoin(coin: CoinState): CanonicalValue {
  return {
    index: coin.index,
    token: coin.token,
    symbol: coin.symbol,
    decimals: coin.decimals,
    reportedDecimals: coin.reportedDecimals,
    poolBalance: coin.poolBalance === null ? null : coin.poolBalance.toString(10),
    storedRate: coin.storedRate === null ? null : coin.storedRate.toString(10),
    walletBalance: coin.walletBalance === null ? null : coin.walletBalance.toString(10),
    allowance: coin.allowance === null ? null : coin.allowance.toString(10),
  };
}

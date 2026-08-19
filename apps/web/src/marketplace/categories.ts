/**
 * The four categories, and the language each one is offered in.
 *
 * PRD §8 makes equal depth across these a product requirement rather than a
 * navigation choice, and §14 fixes the plain-language phrasing a first-time
 * reader is asked to choose between. Both are reproduced here rather than
 * paraphrased, because the wording is the part a user actually decides on.
 *
 * `evidenceVector` is §12's list of what a category must show before a claim
 * about performance means anything. It is displayed as an outstanding
 * requirement, not as a set of filled figures: publishing the list and leaving
 * it visibly unfilled is the honest state for a category with no evidence yet.
 */
import type { AgentCategory } from "@mandate/domain";

export const CATEGORY_SLUGS = ["rebalancing", "grid-trading", "yield", "health-factor"] as const;

export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

export interface Category {
  slug: CategorySlug;
  /** The value an agent card carries in `x-mandate.category`. */
  key: AgentCategory;
  /** The heading. */
  name: string;
  /** PRD §14's plain-language task line, verbatim. */
  task: string;
  /** What the agent is actually being asked to decide, in one sentence. */
  decision: string;
  /** PRD §12's evidence vector for this category. */
  evidenceVector: readonly string[];
  /** The shape of authority a mandate in this category has to grant. */
  authorityShape: string;
  /** The overstatement §12 warns against for this category. */
  caution: string;
}

export const CATEGORIES: readonly Category[] = [
  {
    slug: "rebalancing",
    key: "REBALANCING",
    name: "Rebalancing",
    task: "Keep my LP position managed",
    decision:
      "When a concentrated liquidity position drifts out of its range, decide whether moving it earns back more than the move costs.",
    evidenceVector: [
      "protocol",
      "pool or position type",
      "time in range where measurable",
      "rebalance count",
      "average rebalance cost",
      "gas drag",
      "slippage",
      "residual idle assets",
      "fees collected",
      "position value against a declared baseline",
      "policy violations",
      "evidence window",
      "capital range",
      "trial history",
    ],
    authorityShape:
      "A position manager contract, the handful of selectors that move a range, a spend cap on the assets in the pair, and no path to an arbitrary recipient.",
    caution:
      "LP performance does not reduce to impermanent loss saved. A counterfactual claim needs a baseline defined in advance.",
  },
  {
    slug: "grid-trading",
    key: "GRID",
    name: "Grid Trading",
    task: "Run a grid strategy",
    decision:
      "Place and maintain a ladder of orders around a price, and adjust the rungs as the market moves.",
    evidenceVector: [
      "pair",
      "grid configuration class",
      "capital deployed",
      "realized PnL",
      "maximum drawdown",
      "fees",
      "gas",
      "turnover",
      "completed fills",
      "failed fills",
      "slippage",
      "policy violations",
      "duration",
      "trial outcomes",
    ],
    authorityShape:
      "A router or order contract, the order-placing selectors, a spend cap per asset, and an accounting of the open orders that outlive the session.",
    caution:
      "A short profitable trial does not prove alpha. A trial proves operational correctness and policy adherence; performance claims need longitudinal evidence.",
  },
  {
    slug: "yield",
    key: "YIELD",
    name: "Yield Optimisation",
    task: "Move idle capital to better yield",
    decision:
      "Compare the yield available across eligible protocols and decide whether moving capital beats the cost of moving it.",
    evidenceVector: [
      "eligible protocols",
      "realized portfolio return",
      "benchmark-relative return",
      "gas drag",
      "protocol-switch cost",
      "capital utilization",
      "drawdown where relevant",
      "stale-opportunity errors",
      "idle time",
      "evidence period",
      "mandate-native actions",
    ],
    authorityShape:
      "Every protocol the agent may move capital into, the deposit and withdraw selectors on each, a spend cap per asset, and no route that lets capital leave the wallet.",
    caution:
      "Moving capital between protocols is an internal reallocation. Counting it as a deposit or withdrawal would corrupt time-weighted return.",
  },
  {
    slug: "health-factor",
    key: "HEALTH_FACTOR",
    name: "Health Factor Monitoring",
    task: "Protect my loan from liquidation",
    decision:
      "Watch a borrow position, and when its health factor falls below a threshold, repay enough to lift it back to target.",
    evidenceVector: [
      "monitored protocol",
      "intervention threshold",
      "target health factor",
      "detection latency",
      "intervention latency",
      "collateral or repayment used",
      "resulting health factor",
      "number of interventions",
      "liquidations following intervention in the observation window",
      "false interventions",
      "missed threshold events",
      "policy violations",
    ],
    authorityShape:
      "One lending market, the repay selector, a spend cap on the borrowed asset per UTC day, and a lifetime after which the session stops working on its own.",
    caution:
      "A prevented liquidation is not a defensible figure without a counterfactual. Interventions and subsequent liquidations in a stated window are.",
  },
];

export function categoryBySlug(slug: string): Category | undefined {
  return CATEGORIES.find((category) => category.slug === slug);
}

export function categoryByKey(key: AgentCategory): Category | undefined {
  return CATEGORIES.find((category) => category.key === key);
}

/**
 * The independent reference model for the rebalancing category.
 *
 * It reads the same raw facts the agent reads, from `@mandate/venus-bsc`, and
 * reaches its own conclusion by its own route: the agent values a position in
 * two steps and floors at the underlying, while this model multiplies through
 * and divides once; the agent sizes a market from `totalSupply * exchangeRate`,
 * while this model adds up `cash + borrows - reserves` and publishes the
 * disagreement between the two as drift.
 *
 * The one thing the two must agree on exactly is the decision, so both write
 * the drift trigger out as a cross-multiplied integer comparison with no
 * division in it. Neither imports the other's version. A shared predicate would
 * be the single point of failure this whole arrangement exists to remove.
 *
 * It imports nothing from any agent, and no agent imports it.
 * `test/independence.test.ts` asserts both directions, because the value of the
 * whole trial rests on it: two implementations that share their accounting
 * share their bugs, and an evaluator that agrees with the agent for that reason
 * certifies the error instead of catching it.
 */
export * from "./scale.js";
export * from "./allocation.js";
export * from "./model.js";
export * from "./identity.js";

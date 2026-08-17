/**
 * The independent reference model for the health-factor category.
 *
 * It reads the same raw facts the agent reads, from `@mandate/venus-bsc`, and
 * reaches its own conclusion. It imports nothing from any agent, and no agent
 * imports it. `test/independence.test.ts` asserts both directions, because the
 * value of the whole trial rests on it: two implementations that share their
 * accounting share their bugs, and an evaluator that agrees with the agent for
 * that reason certifies the error instead of catching it.
 */
export * from "./scale.js";
export * from "./accounting.js";
export * from "./model.js";
export * from "./identity.js";

/**
 * The independent reference model for the grid category.
 *
 * It reads the same raw facts the agent reads, from `@mandate/stableswap-bsc`,
 * and reaches its own conclusion by a route the agent does not have: the agent
 * asks the pool's `get_dy` what a swap returns, and this model solves the
 * invariant for itself from balances, rate multipliers, amplification and both
 * fee parameters. The reconstruction reproduces the deployed pool wei for wei
 * on chain 97, which is what makes the agreement a reconciliation rather than a
 * restatement of a single answer.
 *
 * It imports nothing from any agent, and no agent imports it.
 * `test/independence.test.ts` asserts both directions, because the value of the
 * whole trial rests on it: two implementations that share their pricing share
 * their bugs, and an evaluator that agrees with the agent for that reason
 * certifies the error instead of catching it.
 */
export * from "./invariant.js";
export * from "./ladder.js";
export * from "./model.js";
export * from "./identity.js";

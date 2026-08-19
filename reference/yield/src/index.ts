/**
 * The independent reference model for the yield category.
 *
 * It reads the same raw facts the agent reads, from `@mandate/venus-bsc`, and
 * reaches its own conclusion by its own route: the agent annualises each
 * market's rate upward and compares against a basis-point floor, while this
 * model converts the floor down to a per-block rate and compares the protocol's
 * raw readings; the agent sizes a market from `totalSupply * exchangeRate`,
 * while this model adds up `cash + borrows - reserves`.
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

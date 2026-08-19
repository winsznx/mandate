/**
 * Venus protocol adapter for BSC.
 *
 * Exports protocol facts and chain reads. It exports no health-factor
 * computation, no risk predicate and no repayment sizing, on purpose: the agent
 * and the reference model must reach their conclusions independently, or a
 * shared accounting bug would make the agent wrong and the evaluator agree.
 */
export * from "./abis.js";
export * from "./addresses.js";
export * from "./errors.js";
export * from "./observation.js";
export * from "./reads.js";
export * from "./supply.js";

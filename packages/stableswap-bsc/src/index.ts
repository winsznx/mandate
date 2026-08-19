/**
 * Stableswap-NG protocol adapter for BSC.
 *
 * Exports protocol facts and chain reads. It exports no price computation, no
 * invariant solver and no trade sizing, on purpose: the agent and the reference
 * model must reach their conclusions independently, or a shared pricing bug
 * would make the agent wrong and the evaluator agree.
 *
 * The pool's own `get_dy` is recorded in the observation because it is a fact
 * the chain stated. Turning that fact into a verdict is somebody else's job,
 * and the reference model deliberately does it by solving the invariant instead.
 */
export * from "./abis.js";
export * from "./addresses.js";
export * from "./observation.js";
export * from "./reads.js";

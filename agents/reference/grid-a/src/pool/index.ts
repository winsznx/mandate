/**
 * The pool surface this agent reads through.
 *
 * Exported as a subpath so a harness can build the same reader the process
 * entry point builds, pointed at a fork instead of at the public RPC, and so
 * `grid-b` can run the identical deliberation under a different ladder. Without
 * it a trial would have to reimplement the agent's chain access and would then
 * be testing the reimplementation.
 */
export * from "./abi.js";
export * from "./addresses.js";
export * from "./grid.js";
export * from "./reader.js";

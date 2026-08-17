/**
 * What an RPC endpoint can actually do, measured rather than assumed.
 *
 * The constant this package replaces was "~2,048 blocks back on publicnode",
 * and it was wrong in both directions at once: a historical `eth_call` reached
 * fifty times further, and an anvil fork of the same provider did not always
 * reach that far. Two capabilities, two boundaries, neither of them a number a
 * provider publishes and both of them moving with the head.
 *
 * The question a scheduler asks here is `canForkBlock(capabilities, block)`,
 * and it has three answers. `UNKNOWN` means the measurement does not cover the
 * block, and the only correct responses are to probe or to refuse. Refusing
 * produces the trial runner's own `FORK_STATE_UNAVAILABLE` with
 * `pausesQueue: true`; there is no code path here that returns a different
 * block than the one it was asked about.
 */
export * from "./cache.js";
export * from "./capabilities.js";
export * from "./errors.js";
export * from "./fork-state.js";
export * from "./historical-call.js";
export * from "./known-contracts.js";
export * from "./probe.js";
export * from "./rpc.js";
export * from "./search.js";

import { defineConfig } from "vitest/config";

/**
 * The live suite: real RPCs, real anvil forks, no mocks anywhere.
 *
 * A fork probe spawns a process and waits for it to sync a genesis from a free
 * endpoint, so the timeouts here are minutes rather than seconds. The suite is
 * sequential because several concurrent forks against the same free RPC produce
 * rate-limit failures that look exactly like pruned state.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});

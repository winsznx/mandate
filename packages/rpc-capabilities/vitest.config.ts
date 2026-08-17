import { defineConfig } from "vitest/config";

/**
 * The default suite is the one CI runs, so it contains no network at all.
 *
 * Every probe in this package is a measurement of a third-party endpoint, and a
 * measurement makes a poor gate: publicnode's retention window moves, its rate
 * limiter answers differently under load, and an anvil fork takes tens of
 * seconds. A suite that goes red because a free RPC was busy trains people to
 * ignore red suites. The live probes live under `test/live` and run on demand
 * via `pnpm test:live`.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node only. Every module under test is a pure function over documents the
    // server already fetched, so a DOM would add a dependency and prove nothing.
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

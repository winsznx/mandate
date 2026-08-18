import type { NextConfig } from "next";

/**
 * The workspace packages publish TypeScript source rather than a build output,
 * so Next compiles them itself. Listing them explicitly keeps the proof page
 * reading the same hashing, comparator and account-read code the CLI verifier
 * reads, instead of a second implementation that could drift from it.
 */
const WORKSPACE_PACKAGES = ["@mandate/altana", "@mandate/authority-ir", "@mandate/domain"];

/**
 * Those packages compile under `moduleResolution: NodeNext`, so their internal
 * imports carry the `.js` specifier NodeNext requires even though the files on
 * disk are `.ts`. A bundler has to be told about that rewrite, and
 * `extensionAlias` is the supported way to say it — which is why this app builds
 * with webpack rather than Turbopack. Editing the packages to drop the
 * extensions would fix the bundler and break `tsc` for every Node consumer,
 * including the verifier a judge runs from a terminal.
 */
const config: NextConfig = {
  transpilePackages: WORKSPACE_PACKAGES,
  typedRoutes: true,
  poweredByHeader: false,
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    },
  },
};

export default config;

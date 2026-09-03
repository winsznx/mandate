#!/usr/bin/env node
/**
 * Regenerate every reference agent's marketplace card.
 *
 * Each card is written by running that agent's own entry point with
 * `MANDATE_EMIT_CARD` set, so the artifact a judge reads through the
 * marketplace is byte-identical to the card the running agent serves at
 * `/.well-known/agent-card.json`. A hand-maintained copy would drift.
 * `AGENT_PUBLIC_URL` sets the `url` the emitted card advertises.
 *
 * The `url` each card advertises is the agent's intended stable host. A card
 * may name a host before it is live: the marketplace probes the endpoint at
 * request time and shows "offline" honestly rather than the card lying.
 *
 * Usage:  node scripts/emit-agent-cards.mjs
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** slug -> intended public host. Kept here so one edit repoints the fleet. */
const AGENT_HOSTS = {
  "grid-a": "https://mandate-grid-a.up.railway.app",
  "grid-b": "https://mandate-grid-b.up.railway.app",
  "health-factor-a": "https://mandate-health-factor-a.up.railway.app",
  "health-factor-b": "https://mandate-health-factor-b.up.railway.app",
  "rebalancing-a": "https://mandate-rebalancing-a.up.railway.app",
  "rebalancing-b": "https://mandate-rebalancing-b.up.railway.app",
  "yield-a": "https://mandate-yield-a.up.railway.app",
  "yield-b": "https://mandate-yield-b.up.railway.app",
};

let emitted = 0;
for (const [slug, host] of Object.entries(AGENT_HOSTS)) {
  const agentDir = join(repoRoot, "agents", "reference", slug);
  const cardPath = join(repoRoot, "artifacts", "agents", `${slug}.json`);

  execFileSync("pnpm", ["exec", "tsx", "src/main.ts"], {
    cwd: agentDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      AGENT_PUBLIC_URL: host,
      MANDATE_EMIT_CARD: cardPath,
    },
  });

  console.log(`  ${slug} -> ${cardPath}`);
  emitted += 1;
}

console.log(`\nEmitted ${emitted} agent card${emitted === 1 ? "" : "s"}.`);

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

/**
 * slug -> public host. All eight run on one Cloudflare Worker
 * (`agents/gateway`), path-routed by slug. One edit repoints the fleet.
 */
const GATEWAY_ORIGIN = "https://mandate-agents.timjosh507.workers.dev";
const SLUGS = [
  "grid-a",
  "grid-b",
  "health-factor-a",
  "health-factor-b",
  "rebalancing-a",
  "rebalancing-b",
  "yield-a",
  "yield-b",
];
const AGENT_HOSTS = Object.fromEntries(SLUGS.map((slug) => [slug, `${GATEWAY_ORIGIN}/${slug}`]));

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

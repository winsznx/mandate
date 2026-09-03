/**
 * Reading the repository's own published files.
 *
 * There is no API and no database behind this marketplace. The inventory is
 * whatever has actually been published to `artifacts/`, so the page reads that
 * rather than a table someone could edit without leaving a trace. A category
 * with nothing published renders an empty state, which is the correct answer
 * rather than a failure.
 *
 * The files are read from `published-snapshot.generated.ts`, a build-time
 * bundle of exactly the artifacts the inventory needs. Reading `artifacts/`
 * off disk with `node:fs` worked under Node but not on Cloudflare Workers,
 * where there is no repository on disk. The snapshot is regenerated from the
 * artifacts by `scripts/emit-published-snapshot.mjs` and checked in CI, so it
 * cannot drift from them and cannot be edited without the artifacts changing.
 *
 * Nothing here reaches the network.
 */
import { SNAPSHOT_DIRS, SNAPSHOT_FILES } from "./published-snapshot.generated";

/**
 * The names of the JSON files in a published directory, sorted.
 *
 * A directory the snapshot does not know about returns nothing rather than
 * throwing. "Nobody has published here yet" is a state the interface has to
 * render, not an error it should crash on.
 */
export function listJsonFiles(relativeDir: string): string[] {
  const entries = SNAPSHOT_DIRS[relativeDir];
  if (entries === undefined) return [];
  return entries.filter((name) => name.endsWith(".json"));
}

export function listDirectories(relativeDir: string): string[] {
  const entries = SNAPSHOT_DIRS[relativeDir];
  return entries === undefined ? [] : [...entries];
}

/** Parsed JSON, or `undefined` when the file is not in the snapshot. */
export function readJsonFile(relativePath: string): unknown {
  return Object.prototype.hasOwnProperty.call(SNAPSHOT_FILES, relativePath)
    ? SNAPSHOT_FILES[relativePath]
    : undefined;
}

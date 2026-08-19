/**
 * Reading the repository's own published files from the server.
 *
 * There is no API and no database behind this marketplace. The inventory is
 * whatever has actually been published to `artifacts/`, so the page reads that
 * directory directly rather than a table someone could edit without leaving a
 * trace. A category with nothing published renders an empty state, which is the
 * correct answer rather than a failure.
 *
 * The root is found by walking up for `pnpm-workspace.yaml` instead of being
 * written down. A hard-coded path would be wrong on every machine but one, and
 * a path relative to `process.cwd()` would break the moment the app is started
 * from somewhere other than its own directory.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WORKSPACE_MARKER = "pnpm-workspace.yaml";

let cachedRoot: string | undefined;

export function repoRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;

  let current = resolve(process.cwd());
  for (;;) {
    if (exists(join(current, WORKSPACE_MARKER))) {
      cachedRoot = current;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `no ${WORKSPACE_MARKER} above ${process.cwd()}; the published artifacts cannot be located`,
      );
    }
    current = parent;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The names of the JSON files in a published directory, sorted.
 *
 * A missing directory returns nothing rather than throwing. "Nobody has
 * published here yet" is a state the interface has to render, not an error it
 * should crash on.
 */
export function listJsonFiles(relativeDir: string): string[] {
  try {
    return readdirSync(join(repoRoot(), relativeDir))
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

export function listDirectories(relativeDir: string): string[] {
  try {
    return readdirSync(join(repoRoot(), relativeDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Parsed JSON, or `undefined` when the file is absent or unreadable. */
export function readJsonFile(relativePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot(), relativePath), "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

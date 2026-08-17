import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { forkStateUnavailable, RpcCapabilityError } from "../src/errors.js";

/**
 * The runner owns `FORK_STATE_UNAVAILABLE`. This package only restates it.
 *
 * It restates rather than imports because the dependency runs the other way —
 * a service may depend on a package, and the reverse edge would make the two
 * impossible to build in order. Duplication bought that, and duplication rots,
 * so this suite reads the runner's source and fails when the two drift.
 *
 * Reading source text rather than importing the module is the point: an import
 * would create exactly the edge being avoided.
 */

const runnerErrors = readFileSync(
  fileURLToPath(new URL("../../../services/trial-runner/src/errors.ts", import.meta.url)),
  "utf8",
);

describe("the mirrored infrastructure error", () => {
  it("uses a kind the runner actually declares", async () => {
    // #given the runner's own error union
    // #then the kind mirrored here is a member of it, so a record produced by
    // this package is one the runner's queue already knows how to handle
    expect(runnerErrors).toContain('| "FORK_STATE_UNAVAILABLE"');
  });

  it("agrees with the runner that this kind pauses the queue", async () => {
    // #given the runner's queue-pausing set
    const queuePausing = /QUEUE_PAUSING[^=]*=\s*\[([^\]]*)\]/.exec(runnerErrors)?.[1] ?? "";

    // #then FORK_STATE_UNAVAILABLE is in it there, and true here. A capability
    // refusal that let the queue keep running would send every trial behind it
    // into the same failure.
    expect(queuePausing).toContain("FORK_STATE_UNAVAILABLE");
    expect(forkStateUnavailable("state is gone", 1_000).pausesQueue).toBe(true);
  });

  it("carries the same fields the runner's record carries", async () => {
    // #given the runner's TrialErrorRecord declaration
    const declaration = /interface TrialErrorRecord \{([\s\S]*?)\n\}/.exec(runnerErrors)?.[1] ?? "";
    const runnerFields = [...declaration.matchAll(/readonly (\w+):/g)].map((match) => match[1]);

    // #when the mirrored record is built
    const mirrored = forkStateUnavailable("state is gone", 1_000);

    // #then every field the runner declares is present with the same name, so
    // the two are interchangeable at a boundary rather than merely similar
    expect(runnerFields.length).toBeGreaterThan(0);
    for (const field of runnerFields) {
      expect(Object.keys(mirrored)).toContain(field);
    }
  });

  it("names the kind in the thrown error's message, as the runner does", async () => {
    // #given the mirrored exception
    const error = new RpcCapabilityError("the RPC has pruned the state at block 1");

    // #then the message leads with the kind, so a log line is greppable the
    // same way on both sides
    expect(error.message).toBe("FORK_STATE_UNAVAILABLE: the RPC has pruned the state at block 1");
    expect(error.kind).toBe("FORK_STATE_UNAVAILABLE");
  });

  it("raises no kind the runner does not know", async () => {
    // #given this package's whole error surface
    const source = readFileSync(fileURLToPath(new URL("../src/errors.ts", import.meta.url)), "utf8");
    const kinds = [...source.matchAll(/"([A-Z][A-Z_]+)"/g)].map((match) => match[1]);

    // #then every kind it can produce is one the runner declares. Inventing a
    // second vocabulary for infrastructure failure is how a queue ends up with
    // a case it silently ignores.
    for (const kind of new Set(kinds)) {
      expect(runnerErrors).toContain(`"${kind}"`);
    }
  });
});

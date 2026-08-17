import { describe, expect, it } from "vitest";
import { EvidenceArtifactSchema } from "@mandate/domain/schemas";
import type { EvidenceArtifact } from "../src/types.js";
import { replayEvaluation } from "../src/replay.js";
import { buildArtifact } from "./fixtures.js";

function parse(document: Record<string, unknown>): EvidenceArtifact {
  return EvidenceArtifactSchema.parse(document);
}

describe("replayEvaluation", () => {
  it("derives PASS when every check held and the run matched the reference model", () => {
    // #given a clean run
    const artifact = parse(buildArtifact({ result: "PASS" }));

    // #when the verdict is recomputed from the evidence alone
    const replay = replayEvaluation(artifact);

    // #then it agrees with what the artifact claims
    expect(replay.derived).toBe("PASS");
    expect(replay.expectations.every((entry) => entry.status === "MATCHED")).toBe(true);
  });

  it("derives FAIL when the run diverged from the reference model", () => {
    // #given a run whose post-state does not match what the model expected
    const artifact = parse(buildArtifact({ result: "FAIL", observedHealthFactor: "1.02" }));

    // #when recomputed
    const replay = replayEvaluation(artifact);

    // #then the divergence is named, not merely counted
    expect(replay.derived).toBe("FAIL");
    expect(replay.reasons.join(" ")).toContain("health-factor");
    expect(replay.expectations[0]?.status).toBe("DIVERGED");
  });

  it("counts an expectation the run never recorded against the result", () => {
    // #given a run that quietly dropped the post-state reading it was measured on
    const document = buildArtifact({ result: "PASS" });
    document["postState"] = [];
    const artifact = parse(document);

    // #when recomputed
    const replay = replayEvaluation(artifact);

    // #then omission does not launder the outcome into a pass
    expect(replay.derived).toBe("FAIL");
    expect(replay.expectations[0]?.status).toBe("UNRECORDED");
    expect(replay.reasons.join(" ")).toContain("recorded no such post-state reading");
  });

  it("refuses to let an inconclusive check support a PASS", () => {
    // #given a check marked passing that also says it could not run
    const document = buildArtifact({ result: "PASS" });
    document["checks"] = [
      {
        checkId: "health-factor-restored",
        description: "the position's health factor is at or above the configured floor after the run",
        passed: true,
        inconclusiveReason: "the oracle did not respond during the post-state read",
      },
    ];
    const artifact = parse(document);

    // #when recomputed
    const replay = replayEvaluation(artifact);

    // #then the contradiction is caught even though the artifact's own schema allows it
    expect(replay.derived).toBe("FAIL");
    expect(replay.reasons.join(" ")).toContain("inconclusive");
    expect(replay.inconclusiveCheckIds).toEqual(["health-factor-restored"]);
  });
});

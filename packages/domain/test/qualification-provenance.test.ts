import { describe, expect, it } from "vitest";
import {
  QUALIFICATION_STAGES,
  displayProvenance,
  provenanceCeilingFor,
  provenanceIsSupported,
} from "../src/qualification.js";
import { EVIDENCE_PROVENANCE, provenanceRank } from "../src/provenance.js";

/**
 * MANDATE ships four categories at deliberately different depths and presents
 * that honestly through the provenance ladder. These tests are what stop the
 * ladder being decoration: a scaffold agent that merely answers a handshake
 * cannot be displayed as though it passed a trial.
 */
describe("provenance is bounded by qualification", () => {
  it("caps a bare registration at a developer's claim", () => {
    // #given an identity with nothing proven behind it
    // #then the strongest thing sayable is that someone claimed it
    expect(provenanceCeilingFor("REGISTERED")).toBe("Claimed");
  });

  it("does not let a merely callable agent claim a trial", () => {
    // #given an endpoint that answers a handshake
    // #when it asserts trial evidence
    // #then the assertion is unsupported, because answering is not evidence of
    // financial behaviour
    expect(provenanceIsSupported("Trial-verified", "CALLABLE")).toBe(false);
  });

  it("permits trial evidence only once a trial has been passed", () => {
    expect(provenanceIsSupported("Trial-verified", "CATEGORY_COMPATIBLE")).toBe(false);
    expect(provenanceIsSupported("Trial-verified", "TRIAL_VERIFIED")).toBe(true);
  });

  it("reserves mandate-native evidence for agents that have actually executed", () => {
    expect(provenanceIsSupported("Mandate-native", "TRIAL_VERIFIED")).toBe(false);
    expect(provenanceIsSupported("Mandate-native", "MANDATE_NATIVE")).toBe(true);
  });

  it("clamps an overstated label and says that it did", () => {
    // #given a scaffold agent whose stored label overstates its evidence
    const result = displayProvenance("Mandate-verified", "CALLABLE");

    // #then the display falls back to what the stage supports, and flags it,
    // so the interface can explain rather than silently downgrade
    expect(result.provenance).toBe("Public Activity");
    expect(result.clamped).toBe(true);
  });

  it("leaves an honest label untouched", () => {
    const result = displayProvenance("Claimed", "MANDATE_NATIVE");
    expect(result.provenance).toBe("Claimed");
    expect(result.clamped).toBe(false);
  });

  it("never returns a provenance above the ceiling, for any pairing", () => {
    // #given every stage and every provenance
    for (const stage of QUALIFICATION_STAGES) {
      for (const claimed of EVIDENCE_PROVENANCE) {
        // #when the label is resolved for display
        const { provenance } = displayProvenance(claimed, stage);

        // #then it is within the ceiling, with no exception
        expect(provenanceRank(provenance)).toBeLessThanOrEqual(
          provenanceRank(provenanceCeilingFor(stage)),
        );
      }
    }
  });

  it("has a monotonic ceiling, so climbing a stage never weakens evidence", () => {
    // #given the stages in order
    // #then each ceiling is at least as strong as the one before it
    for (let i = 1; i < QUALIFICATION_STAGES.length; i += 1) {
      const previous = provenanceCeilingFor(QUALIFICATION_STAGES[i - 1]!);
      const current = provenanceCeilingFor(QUALIFICATION_STAGES[i]!);
      expect(provenanceRank(current)).toBeGreaterThanOrEqual(provenanceRank(previous));
    }
  });
});

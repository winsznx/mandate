import { describe, expect, it } from "vitest";
import { formatTrialOutcome, getAllowedProvenanceFields } from "../src/marketplace/provenance-gating";

describe("Provenance Gating Rules", () => {
  it("strictly forbids trial PASS or receipt for Claimed, Public Activity, and Identity-bound agents", () => {
    expect(getAllowedProvenanceFields("Claimed").canShowTrialPass).toBe(false);
    expect(getAllowedProvenanceFields("Public Activity").canShowTrialPass).toBe(false);
    expect(getAllowedProvenanceFields("Identity-bound").canShowTrialPass).toBe(false);

    expect(formatTrialOutcome("Claimed", "PASS")).toBe("Not yet evidenced");
    expect(formatTrialOutcome("Public Activity", "PASS")).toBe("Not yet evidenced");
    expect(formatTrialOutcome("Identity-bound", "PASS")).toBe("Not yet evidenced");
  });

  it("allows trial PASS and receipt ONLY for Trial-verified and above", () => {
    expect(getAllowedProvenanceFields("Trial-verified").canShowTrialPass).toBe(true);
    expect(getAllowedProvenanceFields("Mandate-native").canShowTrialPass).toBe(true);
    expect(getAllowedProvenanceFields("Mandate-verified").canShowTrialPass).toBe(true);

    expect(formatTrialOutcome("Trial-verified", "PASS")).toBe("PASS");
    expect(formatTrialOutcome("Mandate-native", "PASS")).toBe("PASS");
  });

  it("requires Mandate-native or higher for execution claim", () => {
    expect(getAllowedProvenanceFields("Trial-verified").canShowMandateExecution).toBe(false);
    expect(getAllowedProvenanceFields("Mandate-native").canShowMandateExecution).toBe(true);
    expect(getAllowedProvenanceFields("Mandate-verified").canShowMandateExecution).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { RUNGS, rungFor } from "../src/marketplace/provenance-view";
import { EVIDENCE_PROVENANCE } from "@mandate/domain";
import type { EvidenceProvenance } from "@mandate/domain";

describe("Provenance Levels (6-tier Evidence Ladder)", () => {
  it("defines exactly 6 evidence provenance levels in strict hierarchical order", () => {
    expect(EVIDENCE_PROVENANCE).toHaveLength(6);
    expect(EVIDENCE_PROVENANCE).toEqual([
      "Claimed",
      "Public Activity",
      "Identity-bound",
      "Trial-verified",
      "Mandate-native",
      "Mandate-verified",
    ]);
  });

  it("contains complete metadata, ranks, and glyphs for all 6 rungs", () => {
    expect(RUNGS).toHaveLength(6);

    const provenances: EvidenceProvenance[] = [
      "Claimed",
      "Public Activity",
      "Identity-bound",
      "Trial-verified",
      "Mandate-native",
      "Mandate-verified",
    ];

    provenances.forEach((prov, expectedRank) => {
      const rung = rungFor(prov);
      expect(rung.provenance).toBe(prov);
      expect(rung.rank).toBe(expectedRank);
      expect(rung.meaning).toBeDefined();
      expect(rung.meaning.length).toBeGreaterThan(0);
      expect(rung.requirement).toBeDefined();
      expect(rung.limit).toBeDefined();
    });
  });

  it("ensures Identity-bound agents do not claim trial verification without a receipt", () => {
    const identityBoundRung = rungFor("Identity-bound");
    expect(identityBoundRung.meaning).toContain("identity");
    expect(identityBoundRung.limit).toContain("says nothing about whether they acted well");

    const trialRung = rungFor("Trial-verified");
    expect(trialRung.requirement).toContain("trial receipt");
  });
});

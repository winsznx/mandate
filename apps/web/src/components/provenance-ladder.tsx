import type { EvidenceProvenance } from "@mandate/domain";
import { RUNGS, RUNG_COUNT, rungFor } from "../marketplace/provenance-view";

/**
 * A rung, drawn as its position on the whole ladder.
 *
 * The bars are the aesthetic bet of this interface: an agent's standing should
 * be legible before its name is, and it should be legible without colour. Six
 * segments of rising height, filled to the rung, plus the rung's name, its
 * glyph and "4 of 6" in words. Any one of those three readings is enough on its
 * own, which is what makes it safe on a monochrome print, in a screenshot and
 * to a screen reader.
 */
export function ProvenanceLadder({
  provenance,
  size = "sm",
}: {
  provenance: EvidenceProvenance;
  size?: "sm" | "lg";
}) {
  const rung = rungFor(provenance);

  return (
    <span className={size === "lg" ? "ladder ladder--lg" : "ladder"}>
      <span aria-hidden="true" className="ladder__bars">
        {RUNGS.map((entry) => (
          <span
            className={entry.rank <= rung.rank ? "ladder__bar ladder__bar--filled" : "ladder__bar"}
            key={entry.provenance}
          />
        ))}
      </span>
      <span className="ladder__text">
        <span aria-hidden="true" className="ladder__glyph">
          {rung.glyph}
        </span>
        <span className="ladder__name">{rung.provenance}</span>
        <span className="ladder__rank">
          rung {rung.rank + 1} of {RUNG_COUNT}
        </span>
      </span>
    </span>
  );
}

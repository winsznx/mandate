import { describe, expect, it } from "vitest";
import { decideVerdict, fail, orderSteps, pass, skip, STEP_IDS, TRIAL_STEP_IDS } from "../src/steps.js";

const CLEAN = STEP_IDS.map((id) => pass(id));

describe("decideVerdict", () => {
  it("is VERIFIED only when every step ran and held", () => {
    // #given a full set of passing steps on a current receipt
    // #when reduced
    // #then the strongest verdict is available
    expect(decideVerdict({ steps: CLEAN, stale: false })).toBe("VERIFIED");
  });

  it("caps at PARTIALLY VERIFIED when a step could not run", () => {
    // #given one step that was skipped for lack of a disclosure
    const steps = [...CLEAN.slice(1), skip("granted authority", "no disclosure was supplied")];

    // #when reduced
    // #then a skip can never be laundered into a verified claim
    expect(decideVerdict({ steps, stale: false })).toBe("PARTIALLY VERIFIED");
  });

  it("reports STALE above PARTIALLY VERIFIED, because expiry is the dominant fact", () => {
    // #given an expired receipt with an unchecked step
    const steps = [...CLEAN.slice(1), skip("blocked execution", "no execution was disclosed")];

    // #when reduced past the freshness horizon
    // #then staleness leads, since the receipt is no longer current certification
    expect(decideVerdict({ steps, stale: true })).toBe("STALE");
  });

  it("reports FAILED even when the receipt is also stale", () => {
    // #given a contradicted claim on an expired receipt
    const steps = [...CLEAN.slice(1), fail("evidence hash", "the bytes hash to something else")];

    // #when reduced
    // #then the contradiction outranks the expiry
    expect(decideVerdict({ steps, stale: true })).toBe("FAILED");
  });
});

describe("orderSteps", () => {
  it("asks a trial receipt only the questions it can answer", () => {
    // #given a trial subject with its six steps reported
    const steps = TRIAL_STEP_IDS.map((id) => pass(id));

    // #when ordered
    const ordered = orderSteps("TRIAL", steps, "not reached");

    // #then the grant-side steps are absent rather than skipped
    expect(ordered.map((step) => step.id)).toEqual([...TRIAL_STEP_IDS]);
    expect(decideVerdict({ steps: ordered, stale: false })).toBe("VERIFIED");
  });

  it("fills an unreported mandate step with a skip so nothing goes unmentioned", () => {
    // #given a mandate run that never reached the execution steps
    const steps = TRIAL_STEP_IDS.map((id) => pass(id));

    // #when ordered as a mandate
    const ordered = orderSteps("MANDATE", steps, "not reached");

    // #then all eleven lines print, and the missing ones say why
    expect(ordered).toHaveLength(STEP_IDS.length);
    expect(ordered.filter((step) => step.status === "SKIP").map((step) => step.reason)).toContain(
      "not reached",
    );
  });
});

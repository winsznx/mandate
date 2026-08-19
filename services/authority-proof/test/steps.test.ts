import { describe, expect, it } from "vitest";
import { PHASE_7_STEPS, Phase7Journal, summarizeSteps } from "../src/phase7/steps.js";

describe("the step catalogue", () => {
  it("puts every read-only step before the first write", () => {
    // #given the declared lifecycle
    const firstWrite = PHASE_7_STEPS.findIndex((step) => step.writes);

    // #then everything before it costs nothing, which is what makes "no partial
    // writes" a property of the ordering rather than of anyone's discipline
    expect(PHASE_7_STEPS.slice(0, firstWrite).every((step) => !step.writes)).toBe(true);
    expect(PHASE_7_STEPS[firstWrite]?.id).toBe("publish-receipt");
  });

  it("publishes the receipt before any authority is granted", () => {
    // #given the positions of the publication and the grant
    const ids = PHASE_7_STEPS.map((step) => step.id);

    // #then a mandate can never exist without a public commitment to the
    // evidence behind it
    expect(ids.indexOf("publish-receipt")).toBeLessThan(ids.indexOf("grant-session"));
    expect(ids.indexOf("standing-approval")).toBeLessThan(ids.indexOf("grant-session"));
    expect(ids.indexOf("revoke-session")).toBeLessThan(ids.indexOf("clear-standing-approval"));
  });

  it("records the revocation only after there is an activation to revoke", () => {
    // #given the declared lifecycle
    const ids = PHASE_7_STEPS.map((step) => step.id);

    // #when the registry-side revocation is placed
    const revocation = ids.indexOf("record-revocation");

    // #then the account was revoked first and the activation exists, so the
    // registry is never asked to revoke a mandate it does not hold
    expect(ids.indexOf("revoke-session")).toBeLessThan(revocation);
    expect(ids.indexOf("record-activation")).toBeLessThan(revocation);
    expect(PHASE_7_STEPS[revocation]?.writes).toBe(true);
  });
});

describe("the journal", () => {
  it("starts every step NOT_RUN so a crash cannot read as a pass", () => {
    // #given a fresh journal
    const journal = new Phase7Journal();

    // #then nothing claims to have happened
    expect(journal.all().every((step) => step.status === "NOT_RUN")).toBe(true);
    expect(journal.passed()).toBe(false);
  });

  it("refuses to move a step backwards", () => {
    // #given a step that has already passed
    const journal = new Phase7Journal();
    journal.begin("chain-identity");
    journal.pass("chain-identity", "chain 97");

    // #then a later write cannot quietly rewrite it, in either direction
    expect(() => journal.fail("chain-identity", "actually no")).toThrow(/monotonic/);
    expect(() => journal.begin("chain-identity")).toThrow(/monotonic/);
  });

  it("names the step that was in flight when a run died", () => {
    // #given a run that began a step and never finished it
    const journal = new Phase7Journal();
    journal.begin("chain-identity");
    journal.pass("chain-identity", "chain 97");
    journal.begin("altana-pins");

    // #then the resume point is that step, so an operator knows what to read on
    // chain before doing anything else
    expect(journal.resumePoint()?.id).toBe("altana-pins");
    expect(journal.resumePoint()?.status).toBe("RUNNING");
  });

  it("distinguishes a step the environment blocked from one an earlier stop made unreachable", () => {
    // #given a run blocked at the deployer balance
    const journal = new Phase7Journal();
    journal.begin("deployer-balance");
    journal.block("deployer-balance", "DEPLOYER_PRIVATE_KEY is not set");
    journal.skipRemaining("stopped: MISSING_DEPLOYER_KEY");

    // #then only one step is BLOCKED. Reporting the rest the same way would say
    // the operator has thirty things to fix when they have one.
    expect(journal.get("deployer-balance").status).toBe("BLOCKED");
    expect(journal.get("grant-session").status).toBe("SKIPPED");
    expect(journal.all().filter((step) => step.status === "BLOCKED")).toHaveLength(1);
  });

  it("accumulates evidence rather than replacing it", () => {
    // #given a step that recorded an observable before reaching a verdict
    const journal = new Phase7Journal();
    journal.begin("venus-target");
    journal.record("venus-target", { label: "target", value: "0xb752" });
    journal.pass("venus-target", "ok", [{ label: "implementation", value: "0x73ff" }]);

    // #then both survive into the manifest
    expect(journal.get("venus-target").evidence.map((entry) => entry.label)).toEqual([
      "target",
      "implementation",
    ]);
  });

  it("summarises with the write steps marked", () => {
    // #given a fresh journal
    const summary = summarizeSteps(new Phase7Journal().all());

    // #then an operator can see at a glance which steps spend money
    expect(summary).toContain("w publish-receipt");
    expect(summary).toContain("  chain-identity");
    expect(summary).toContain("PREFLIGHT");
  });
});

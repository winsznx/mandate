import { describe, expect, it } from "vitest";
import { TrialInfrastructureError, toErrorRecord } from "../src/errors.js";

/**
 * The error taxonomy, which is the mechanism behind two PRD guarantees:
 * §82.3, a crashed runner has no reputation effect, and §82.4, an unavailable
 * fork RPC pauses the queue instead of falling back to mocked state.
 */

const NOW = 1_786_500_000;

describe("infrastructure failures never become verdicts", () => {
  it("produces an ERROR record rather than a FAIL result", () => {
    // #given a fork that died mid-run
    const record = toErrorRecord(new TrialInfrastructureError("FORK_DIED", "anvil exited"), NOW);

    // #then the status is ERROR. There is no code path from here to a
    // published FAIL, because a FAIL is a permanent public statement about an
    // agent and a dead container is not evidence about one.
    expect(record.status).toBe("ERROR");
    expect(record.kind).toBe("FORK_DIED");
  });

  it("carries the operator's detail without dressing it as a result", () => {
    // #given an error with context
    const record = toErrorRecord(
      new TrialInfrastructureError("AGENT_UNREACHABLE", "no answer within 30000ms"),
      NOW,
    );

    // #then the detail survives for the operator, and the record is not a verdict
    expect(record.detail).toContain("30000ms");
    expect(record).not.toHaveProperty("result");
  });
});

describe("queue behaviour", () => {
  it("pauses the queue when the fork RPC cannot serve the pinned state", () => {
    // #given the §82.4 case
    const record = toErrorRecord(
      new TrialInfrastructureError("FORK_STATE_UNAVAILABLE", "state at block 125000000 is pruned"),
      NOW,
    );

    // #then the queue stops. Continuing would mean either fabricating state or
    // silently retesting every agent against a different block than the spec
    // named, and the PRD chooses stopping over both.
    expect(record.pausesQueue).toBe(true);
  });

  it("pauses the queue when the RPC itself is unavailable", () => {
    // #given a transport failure that survived every retry
    const record = toErrorRecord(
      new TrialInfrastructureError("RPC_UNAVAILABLE", "connection error"),
      NOW,
    );

    // #then every trial behind it would fail the same way, so the queue stops
    // rather than burning one scenario per attempt to rediscover that
    expect(record.pausesQueue).toBe(true);
  });

  it("does not pause the queue for a single unreachable agent", () => {
    // #given one agent's endpoint being down
    const record = toErrorRecord(
      new TrialInfrastructureError("AGENT_UNREACHABLE", "connection refused"),
      NOW,
    );

    // #then the rest of the queue proceeds. The problem is that agent's, and
    // the trials behind it are about other agents.
    expect(record.pausesQueue).toBe(false);
  });

  it("does not pause the queue for a declared unimplemented skill", () => {
    // #given a scaffolded agent that refuses loudly
    const record = toErrorRecord(
      new TrialInfrastructureError("AGENT_PROTOCOL_ERROR", "does not implement skill"),
      NOW,
    );

    // #then it is recorded as not implemented rather than as a crash or a
    // failure, and the queue moves on
    expect(record.pausesQueue).toBe(false);
    expect(record.status).toBe("ERROR");
  });
});

describe("unexpected failures", () => {
  it("still produces an error record rather than escaping as a verdict", () => {
    // #given something that is not a TrialInfrastructureError at all
    const record = toErrorRecord(new TypeError("cannot read property of undefined"), NOW);

    // #then it is an ERROR with the message preserved. A bug in the runner must
    // not be able to reach an agent's public record either.
    expect(record.status).toBe("ERROR");
    expect(record.detail).toContain("cannot read property");
    expect(record.observedAt).toBe(NOW);
  });

  it("handles a thrown non-error without losing the context", () => {
    // #given a rejected promise carrying a string
    const record = toErrorRecord("upstream returned 502", NOW);

    // #then the context survives into the record
    expect(record.detail).toBe("upstream returned 502");
  });
});

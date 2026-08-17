import { describe, expect, it } from "vitest";
import { canonicalHash } from "@mandate/domain/canonical";
import { agentCardHash, buildAgentCard } from "../src/agent-card.js";
import { pendingStrategy } from "../src/executor.js";
import { stubExecutor } from "./fixtures.js";

const EXECUTOR = stubExecutor();

function card(publicUrl = "http://localhost:9000") {
  return buildAgentCard({ executor: EXECUTOR, publicUrl, strategyStatus: "IMPLEMENTED" });
}

describe("buildAgentCard", () => {
  it("emits the A2A fields a card-driven adapter reads", () => {
    // #given a reference agent
    // #when its card is built
    const result = card();

    // #then the discovery fields match the shape captured off a live server
    expect(result.protocolVersion).toBe("0.3.0");
    expect(result.preferredTransport).toBe("JSONRPC");
    expect(result.capabilities).toEqual({ streaming: false, pushNotifications: false });
    expect(result.skills.map((skill) => skill.id)).toEqual(["restore-health-factor"]);
    expect(result.skills[0]?.inputModes).toEqual(["application/json"]);
  });

  it("publishes the policy with its hash so a trial can bind to it", () => {
    // #given a policy on the executor
    // #when the card is built
    const extension = card()["x-mandate"];

    // #then the hash is the canonical hash of the published policy
    expect(extension.policy).toEqual(EXECUTOR.policy);
    expect(extension.policyHash).toBe(canonicalHash(EXECUTOR.policy));
  });

  it("declares that its self-reported version is not a build identity", () => {
    // #given upstream hardcodes "1.0.0" in every template
    // #when the card is built
    const result = card();

    // #then the version is emitted for compatibility and flagged as non-authoritative
    expect(result.version).toBe("1.0.0");
    expect(result["x-mandate"].versionIsAuthoritative).toBe(false);
  });

  it("states that it is self-hosted from the Agent Studio scaffold", () => {
    // #given BNB operates no managed platform MANDATE can reach
    // #when the card is built
    const extension = card()["x-mandate"];

    // #then the card says scaffold, not host
    expect(extension.scaffold).toBe("bnb-agent-studio");
    expect(extension.hosting).toBe("self-hosted");
    expect(extension.proposesOnly).toBe(true);
  });

  it("marks a scaffolded strategy as pending", () => {
    // #given an agent whose strategy is not written
    const executor = pendingStrategy({
      slug: "grid-a",
      displayName: "Tight Grid",
      description: "Pending.",
      category: "GRID",
      skills: [{ id: "adjust-grid", name: "Adjust grid", description: "Pending.", tags: [] }],
      policy: {},
    });

    // #when its card is built
    const result = buildAgentCard({ executor, publicUrl: "http://localhost:9000", strategyStatus: "PENDING" });

    // #then the card says so rather than implying a working strategy
    expect(result["x-mandate"].strategyStatus).toBe("PENDING");
  });
});

describe("agentCardHash", () => {
  it("ignores the advertised url, which moves when the agent is redeployed", () => {
    // #given the same agent served from two hostnames
    // #when both cards are hashed
    // #then the hashes agree
    expect(agentCardHash(card("http://localhost:9000"))).toBe(
      agentCardHash(card("https://health-factor-a.up.railway.app")),
    );
  });

  it("changes when a skill description changes", () => {
    // #given an agent whose skill wording was edited
    const edited = buildAgentCard({
      executor: stubExecutor({
        skills: [
          { id: "restore-health-factor", name: "Restore health factor", description: "Edited.", tags: ["venus"] },
        ],
      }),
      publicUrl: "http://localhost:9000",
      strategyStatus: "IMPLEMENTED",
    });

    // #when hashed against the original
    // #then the build is a different one, which supersedes any trial of the old card
    expect(agentCardHash(edited)).not.toBe(agentCardHash(card()));
  });

  it("normalises a trailing slash on the public url", () => {
    // #given the same base url written with and without a trailing slash
    // #when both cards are built
    // #then the advertised url is identical
    expect(card("http://localhost:9000/").url).toBe("http://localhost:9000");
  });
});

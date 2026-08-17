import { describe, expect, it } from "vitest";
import {
  assessQualification,
  entersMarketplaceRanking,
  isDiscoverable,
  qualificationSortKey,
  type QualificationSignals,
} from "../src/qualification.js";

const NOW = 1_790_000_000;

/** A fully qualified agent. Individual tests knock out one signal at a time. */
function signals(overrides: Partial<QualificationSignals> = {}): QualificationSignals {
  return {
    registrationResolves: true,
    registrationWellFormed: true,
    declaresService: true,
    endpointAnswered: true,
    endpointRequiresAuth: false,
    declaresCategory: true,
    acceptsCategoryTask: true,
    hasCurrentPassingTrial: true,
    hasMandateNativeExecution: true,
    publisherIsBulkMinter: false,
    ...overrides,
  };
}

describe("assessQualification", () => {
  it("reaches MANDATE_NATIVE when every signal holds", () => {
    const assessment = assessQualification(signals(), NOW);
    expect(assessment.stage).toBe("MANDATE_NATIVE");
    expect(assessment.blockedBy).toEqual([]);
  });

  it("stops at TRIAL_VERIFIED before any live execution", () => {
    // #given a reference agent that passed a trial but has never been hired
    const assessment = assessQualification(signals({ hasMandateNativeExecution: false }), NOW);

    // #then it is fully hireable but carries no mandate-native history yet
    expect(assessment.stage).toBe("TRIAL_VERIFIED");
    expect(assessment.blockedBy).toEqual([]);
  });

  it("stops at CATEGORY_COMPATIBLE without a current trial, naming the reason", () => {
    const assessment = assessQualification(signals({ hasCurrentPassingTrial: false }), NOW);
    expect(assessment.stage).toBe("CATEGORY_COMPATIBLE");
    expect(assessment.blockedBy).toContain("NO_CURRENT_TRIAL");
  });

  it("stops at REGISTERED when the registration declares no service", () => {
    // #given the shape of ~97% of sampled BSC registrations
    const assessment = assessQualification(signals({ declaresService: false }), NOW);

    // #then it never reaches the marketplace
    expect(assessment.stage).toBe("REGISTERED");
    expect(assessment.blockedBy).toContain("NO_SERVICES_DECLARED");
  });

  it("stops at ENDPOINT_VERIFIED when the endpoint does not answer", () => {
    const assessment = assessQualification(signals({ endpointAnswered: false }), NOW);
    expect(assessment.stage).toBe("ENDPOINT_VERIFIED");
    expect(assessment.blockedBy).toContain("ENDPOINT_UNREACHABLE");
  });

  it("distinguishes an auth-gated endpoint from an unreachable one", () => {
    // #given a Studio agent behind an OAuth bearer, which is running but not
    // anonymously invokable
    const assessment = assessQualification(
      signals({ endpointAnswered: false, endpointRequiresAuth: true }),
      NOW,
    );

    // #then the reason is specific enough for a developer to act on
    expect(assessment.blockedBy).toContain("ENDPOINT_REQUIRES_AUTH");
  });

  it("caps a silent bulk-mint registration at REGISTERED", () => {
    // #given one of the ~75% of sampled registrations from a single bulk minter,
    // whose endpoint does not answer
    const assessment = assessQualification(
      signals({ publisherIsBulkMinter: true, endpointAnswered: false }),
      NOW,
    );

    // #then it is capped, and the reason says why
    expect(assessment.stage).toBe("REGISTERED");
    expect(assessment.blockedBy).toContain("BULK_MINT_PUBLISHER");
  });

  it("lets a real agent from a prolific publisher climb by answering", () => {
    // #given the same publisher heuristic, but an endpoint that responds
    const assessment = assessQualification(signals({ publisherIsBulkMinter: true }), NOW);

    // #then the heuristic does not suppress it. The signal orders presentation;
    // it is not a judgement about truth.
    expect(assessment.stage).toBe("MANDATE_NATIVE");
  });

  it("does not let an old trial compensate for a dead endpoint", () => {
    // #given an agent with a passing trial whose endpoint has since gone down
    const assessment = assessQualification(
      signals({ endpointAnswered: false, hasCurrentPassingTrial: true }),
      NOW,
    );

    // #then it stops at the endpoint. Ranking it on the strength of the old
    // trial would send a user to an agent that cannot be reached.
    expect(assessment.stage).toBe("ENDPOINT_VERIFIED");
  });
});

describe("marketplace admission", () => {
  it("admits an agent only once it is category-compatible", () => {
    expect(entersMarketplaceRanking("CATEGORY_COMPATIBLE")).toBe(true);
    expect(entersMarketplaceRanking("TRIAL_VERIFIED")).toBe(true);
    expect(entersMarketplaceRanking("MANDATE_NATIVE")).toBe(true);
  });

  it("keeps a merely registered or callable agent out of ranking", () => {
    expect(entersMarketplaceRanking("REGISTERED")).toBe(false);
    expect(entersMarketplaceRanking("ENDPOINT_VERIFIED")).toBe(false);
    expect(entersMarketplaceRanking("CALLABLE")).toBe(false);
  });

  it("keeps every registration discoverable through search", () => {
    // #given a registration that will never be hireable
    // #then it is still findable, because a thing that exists on chain should
    // be discoverable. It simply does not compete for placement.
    expect(isDiscoverable("REGISTERED")).toBe(true);
  });

  /**
   * The ordering guarantee the inventory result demands: a bulk-mint entry must
   * never visually rank alongside a reference agent that completed a trial.
   */
  it("sorts a trial-verified agent above a bulk-mint registration", () => {
    const spam = assessQualification(
      signals({ publisherIsBulkMinter: true, endpointAnswered: false, declaresService: true }),
      NOW,
    );
    const proven = assessQualification(signals({ hasMandateNativeExecution: false }), NOW);

    expect(qualificationSortKey(proven)).toBeGreaterThan(qualificationSortKey(spam));
  });
});

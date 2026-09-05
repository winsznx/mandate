import { describe, expect, it } from "vitest";
import { canonicalize } from "@mandate/domain";
import { writeBlocker } from "../src/phase7/blockers.js";
import { resolveConfig } from "../src/phase7/config.js";
import { ARTIFACT_ROOT_RELATIVE, artifactDirectoryFor, buildManifest } from "../src/phase7/manifest.js";
import type { ExecutionRecord } from "../src/phase7/manifest.js";
import { standingAllowancePlan } from "../src/phase7/plan.js";
import { resolveRoles } from "../src/phase7/roles.js";
import type { RoleAddresses } from "../src/phase7/roles.js";
import { Phase7Journal } from "../src/phase7/steps.js";

const RUN_ID = "20260817T170948Z";

const REFUSED_INTENT: ExecutionRecord = {
  step: "cap-breach-attempt",
  label: "repay 6000000 raw USDT, taking the bucket past its 25000000 cap",
  target: "0xb7526572ffe56ab9d7489838bf2e18e3323b441a",
  selector: "0x0e752702",
  amountRaw: "6000000",
  status: "REVERTED",
  attribution: {
    validatorError: "ExceededSpendLimit",
    mechanism: "SPEND_CAP",
    accountState: {
      callPermitted: true,
      keyRegistered: true,
      spendCapRaw: "25000000",
      spentInBucketRaw: "20000000",
      allowanceAtAttemptRaw: "155000000",
    },
  },
};

function manifestOf(
  executions: readonly ExecutionRecord[] = [],
  roles?: RoleAddresses,
): Record<string, unknown> {
  const config = resolveConfig("bsc-testnet", {});
  const journal = new Phase7Journal();
  journal.begin("chain-identity");
  journal.pass("chain-identity", "chain 97 at block 125644865", [
    { label: "blockNumber", value: "125644865" },
  ]);
  journal.begin("altana-pins");
  journal.skipRemaining("stopped: MISSING_OWNER_KEY");

  const document = buildManifest({
    runId: RUN_ID,
    config,
    status: "BLOCKED",
    startedAt: 1_786_500_000,
    finishedAt: 1_786_500_060,
    blockers: [writeBlocker("MISSING_OWNER_KEY", [["variable", "DEPLOYER_PRIVATE_KEY"]])],
    steps: journal.all(),
    facts: {
      observedChainId: 97,
      blockNumber: 125_644_865n,
      relayStatus: "rpc ok",
      pinnedContracts: [],
      allowance: standingAllowancePlan(),
      ...(roles === undefined ? {} : { roles }),
    },
    resumePoint: journal.resumePoint(),
    executions,
    artifacts: [`${ARTIFACT_ROOT_RELATIVE}/${RUN_ID}/proof-manifest.json`],
  });

  return JSON.parse(canonicalize(document)) as Record<string, unknown>;
}

describe("the proof manifest", () => {
  it("encodes canonically, so the bytes on disk are the bytes that were hashed", () => {
    // #given the same manifest built twice
    // #then the encoding is byte-identical rather than depending on key order
    expect(JSON.stringify(manifestOf())).toBe(JSON.stringify(manifestOf()));
  });

  it("carries wide integers as decimal strings", () => {
    // #given a block number and a spend allowance
    const manifest = manifestOf();
    const chain = manifest["chain"] as Record<string, unknown>;
    const allowance = manifest["allowance"] as Record<string, unknown>;

    // #then neither is a JSON number. A cap in base units crosses 2^53 on the
    // first value MANDATE would ever publish.
    expect(chain["blockNumber"]).toBe("125644865");
    expect(allowance["standingAllowanceRaw"]).toBe("1125000000");
  });

  it("names the step that never reached a terminal state", () => {
    // #given a run that stopped with a step in flight
    const resume = manifestOf()["resumePoint"] as Record<string, unknown>;

    // #then an operator knows exactly where to look on chain
    expect(resume["step"]).toBe("altana-pins");
    expect(resume["status"]).toBe("RUNNING");
  });

  it("refuses to promise a resume", () => {
    // #given the manifest of an interrupted run
    const manifest = manifestOf();

    // #then it says so explicitly. A process that died between submitting a
    // transaction and seeing its receipt cannot know which of the two it did.
    expect(manifest["autoResume"]).toBe(false);
    expect(String(manifest["autoResumeNote"])).toContain("never resumes");
  });

  it("states why the allowance is sized to the lifetime", () => {
    // #given the allowance section
    const allowance = manifestOf()["allowance"] as Record<string, unknown>;

    // #then the reader is told what would break if it were sized to one period,
    // rather than being left to infer it from a number
    expect(allowance["capBindsBreach"]).toBe(true);
    expect(String(allowance["note"])).toContain("ERC-20 allowance");
  });

  it("writes only repo-relative paths", () => {
    // #given every path the manifest carries
    const serialised = JSON.stringify(manifestOf());

    // #then no checkout-specific absolute path leaks into a published document
    expect(serialised).not.toMatch(/"\/(Users|home|var|tmp)\//);
    expect(artifactDirectoryFor(RUN_ID).relative).toBe(`${ARTIFACT_ROOT_RELATIVE}/${RUN_ID}`);
  });

  it("carries the account state that attributed a refusal", () => {
    // #given a refused intent, which has no transaction hash and so has nothing
    // but the account's own state at the attempt to stand on
    const executions = manifestOf([REFUSED_INTENT])["executions"] as Record<string, unknown>[];
    const state = executions[0]?.["attribution"] as Record<string, unknown>;

    // #then the nested attribution survives canonical encoding, so a run that
    // records one does not die writing its own manifest
    expect(state["validatorError"]).toBe("ExceededSpendLimit");
    expect(state["mechanism"]).toBe("SPEND_CAP");
    expect((state["accountState"] as Record<string, unknown>)["allowanceAtAttemptRaw"]).toBe(
      "155000000",
    );
  });

  it("omits the parties entirely rather than showing a run half a party short", () => {
    // #given a run that stopped before both keys resolved
    const manifest = manifestOf();

    // #then there is no roles block. A record naming an owner and no agent
    // reads as "there was no agent", which is a different claim from "the run
    // never got that far".
    expect(manifest["roles"]).toBeUndefined();
  });

  it("names all three parties and asserts what separates them", async () => {
    // #given a run whose owner and agent resolved
    const resolved = await resolveRoles({
      ownerPrivateKey: `0x${"11".repeat(32)}`,
      agentPrivateKey: `0x${"22".repeat(32)}`,
      chainId: 97,
      runId: RUN_ID,
    });
    const manifest = manifestOf([], resolved.addresses);
    const roles = manifest["roles"] as Record<string, Record<string, unknown>>;

    // #then each address appears under the role it played, the publisher's
    // double duty is declared, and no private key rode along
    expect(roles["owner"]?.["address"]).toBe(resolved.addresses.owner);
    expect(roles["agent"]?.["address"]).toBe(resolved.addresses.agent);
    expect(roles["agent"]?.["sessionKey"]).toBe(resolved.addresses.sessionKey);
    expect(roles["publisher"]?.["sameAs"]).toBe("owner");
    expect(roles["separation"]?.["ownerIsAgent"]).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain(resolved.sessionPrivateKey.slice(2));
  });

  it("distinguishes a blocker that stops writes from one that stops the run", () => {
    // #given a missing key
    const blockers = manifestOf()["blockers"] as Array<Record<string, unknown>>;

    // #then the manifest records which kind it was, because the two call for
    // different responses
    expect(blockers[0]?.["reason"]).toBe("MISSING_OWNER_KEY");
    expect(blockers[0]?.["haltsRun"]).toBe(false);
  });
});

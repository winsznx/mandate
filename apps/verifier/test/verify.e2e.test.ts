/**
 * The whole path, on a real chain.
 *
 * Deploy the registry with the real deploy script, publish real receipts, then
 * verify them with nothing but an RPC and the files on disk. Every assertion
 * here is about the property the verifier exists to have: that a judge who
 * trusts no MANDATE service can still reach a defensible verdict.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalBytes } from "@mandate/domain/canonical";
import type { CanonicalValue } from "@mandate/domain/canonical";
import { deriveMandateId } from "@mandate/domain";
import { ACCOUNT_ERROR_ABI } from "@mandate/altana";
import { encodeAbiParameters, encodeErrorResult, keccak256, pad, parseEther, toHex } from "viem";
import type { Address, Hex } from "viem";
import { createClient } from "../src/config.js";
import type { ResolvedTarget } from "../src/config.js";
import { renderReport } from "../src/report.js";
import { verifyMandate, verifyTrial } from "../src/verify.js";
import type { VerificationReport } from "../src/verify.js";
import {
  REGISTRY_WRITE_ABI,
  returningCode,
  revertingCode,
  setCode,
  setStubContract,
  startAnvilWithRegistry,
} from "./anvil.js";
import type { AnvilHandle } from "./anvil.js";
import {
  buildArtifact,
  buildBundle,
  buildMandateDisclosure,
  buildReceiptFields,
  GRANTED_AUTHORITY,
  GRANTED_AUTHORITY_HASH,
  NOW_WITHIN_FRESHNESS,
  OVERBROAD_AUTHORITY,
  OVERBROAD_AUTHORITY_HASH,
  TRIAL_SPEC,
} from "./fixtures.js";
import type { ReceiptFields } from "./fixtures.js";

const IDENTITY_REGISTRY = TRIAL_SPEC.agent.identityRegistry as Address;
const SESSION_KEY_HASH = keccak256(toHex("mandate.test.session-key")) as Hex;
/** The call target the tested and granted authorities both permit. */
const GRANTED_TARGET = GRANTED_AUTHORITY.calls[0]?.target as Address;
/** Stands in for the account contract refusing an out-of-scope call. */
const SPEND_CAP_REVERTER = "0x00000000000000000000000000000000000000B1" as Address;

/**
 * The window every activation in this suite commits to, unless it overrides it.
 *
 * `GRANT_VALID_UNTIL` is also the expiry the stubbed account reports for its
 * key, because an activation whose window disagrees with the account is a
 * finding and the default fixture should not be sitting on one.
 */
const GRANT_VALID_FROM = 1_790_000_000n;
const GRANT_VALID_UNTIL = 1_800_000_000n;
/** Earlier than `NOW_WITHIN_FRESHNESS`, so the window has closed on its own. */
const GRANT_CLOSED_UNTIL = 1_790_050_000n;

/** Accounts that answer the permission reads, one per lifecycle state under test. */
const LIVE_ACCOUNT = "0x00000000000000000000000000000000000000c1" as Address;
const REVOKED_ACCOUNT = "0x00000000000000000000000000000000000000c2" as Address;
const VANISHED_ACCOUNT = "0x00000000000000000000000000000000000000c3" as Address;
const LAPSED_ACCOUNT = "0x00000000000000000000000000000000000000c4" as Address;
const CONTRADICTORY_ACCOUNT = "0x00000000000000000000000000000000000000c5" as Address;

const ACCOUNT_KEYS_ABI = [
  {
    type: "tuple[]",
    components: [
      { name: "expiry", type: "uint40" },
      { name: "keyType", type: "uint8" },
      { name: "isSuperAdmin", type: "bool" },
      { name: "publicKey", type: "bytes" },
    ],
  },
  { type: "bytes32[]" },
] as const;

/**
 * One answer that serves every permission read the verifier makes.
 *
 * `readEnforcedAuthority` calls four different views on the same address, so a
 * stub has to return bytes all four can decode. The encoding of `getKeys` does:
 * read as `bytes32[]` it yields the record's own tail offsets as call rules,
 * and read as `spendInfos` it yields one limit. Neither is meaningful, which is
 * the point — what the branches under test turn on is whether the key is there.
 */
function accountAnswer(keyHashes: readonly Hex[]): Hex {
  return encodeAbiParameters(ACCOUNT_KEYS_ABI, [
    keyHashes.map(() => ({
      expiry: Number(GRANT_VALID_UNTIL),
      keyType: 0,
      isSuperAdmin: false,
      publicKey: "0x" as Hex,
    })),
    [...keyHashes],
  ]);
}

let anvil: AnvilHandle;
let workdir: string;
let target: ResolvedTarget;
/** The mandate's wallet. Anvil's deployer, so the suite can actually send from it. */
let wallet: Address;

/** Receipt ids published in `beforeAll`, keyed by what each one is for. */
const published: Record<string, Hex> = {};
const mandates: Record<string, Hex> = {};
const executions: Record<string, Hex> = {};

async function writeDocument(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, bytes);
  return pathToFileURL(path).href;
}

async function publish(fields: ReceiptFields, evidenceURI: string): Promise<Hex> {
  const receiptId = await anvil.publicClient.readContract({
    address: anvil.registry,
    abi: REGISTRY_WRITE_ABI,
    functionName: "computeReceiptId",
    args: [fields, anvil.deployer, evidenceURI],
  });

  const hash = await anvil.walletClient.writeContract({
    address: anvil.registry,
    abi: REGISTRY_WRITE_ABI,
    functionName: "publishReceipt",
    args: [fields, evidenceURI],
    account: anvil.walletClient.account ?? null,
    chain: anvil.walletClient.chain ?? null,
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash });

  return receiptId;
}

interface ActivationOptions {
  disclosureURI?: string;
  /** Defaults to the suite's wallet. Overridden to give a scenario its own account. */
  wallet?: Address;
  validFrom?: bigint;
  validUntil?: bigint;
}

async function activate(
  receiptId: Hex,
  grantedAuthorityHash: Hex,
  options: ActivationOptions = {},
): Promise<Hex> {
  const account = options.wallet ?? wallet;
  const hash = await anvil.walletClient.writeContract({
    address: anvil.registry,
    abi: REGISTRY_WRITE_ABI,
    functionName: "recordActivation",
    args: [
      receiptId,
      account,
      SESSION_KEY_HASH,
      grantedAuthorityHash,
      0,
      options.disclosureURI ?? "file://granted-authority.json",
      options.validFrom ?? GRANT_VALID_FROM,
      options.validUntil ?? GRANT_VALID_UNTIL,
    ],
    account: anvil.walletClient.account ?? null,
    chain: anvil.walletClient.chain ?? null,
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash });

  return deriveMandateId({
    chainId: anvil.chainId,
    wallet: account,
    trialReceiptId: receiptId,
    grantedAuthorityHash,
    sequence: 0,
  });
}

async function recordRevocation(mandateId: Hex): Promise<void> {
  const hash = await anvil.walletClient.writeContract({
    address: anvil.registry,
    abi: REGISTRY_WRITE_ABI,
    functionName: "recordRevocation",
    args: [mandateId],
    account: anvil.walletClient.account ?? null,
    chain: anvil.walletClient.chain ?? null,
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash });
}

async function sendFromWallet(to: Address, value: bigint): Promise<Hex> {
  const hash = await anvil.walletClient.sendTransaction({
    to,
    value,
    gas: 200_000n,
    account: anvil.walletClient.account ?? null,
    chain: anvil.walletClient.chain ?? null,
  });
  await anvil.publicClient.waitForTransactionReceipt({ hash }).catch(() => undefined);
  return hash;
}

function run(receiptId: Hex, options: { now?: number } = {}): Promise<VerificationReport> {
  return verifyTrial(receiptId, {
    target,
    client: anvil.publicClient,
    now: options.now ?? NOW_WITHIN_FRESHNESS,
  });
}

function statusOf(report: VerificationReport, id: string): string {
  return report.steps.find((step) => step.id === id)?.status ?? "MISSING";
}

function reasonOf(report: VerificationReport, id: string): string {
  return report.steps.find((step) => step.id === id)?.reason ?? "";
}

beforeAll(async () => {
  anvil = await startAnvilWithRegistry();
  workdir = await mkdtemp(join(tmpdir(), "mandate-evidence-"));
  wallet = anvil.deployer;

  target = {
    chainId: anvil.chainId,
    rpcUrl: anvil.rpcUrl,
    registry: anvil.registry,
    networkName: "Anvil (local)",
    registrySource: "test harness",
  };

  // Anvil hosts no ERC-8004 registry, so the identity probe gets a stub that
  // reports an owner. Without it the on-chain existence branch never runs.
  await setStubContract(anvil.rpcUrl, IDENTITY_REGISTRY, pad(anvil.deployer, { size: 32 }));

  const passing = buildBundle({ result: "PASS" });
  const failing = buildBundle({ result: "FAIL", observedHealthFactor: "1.02" });

  const passingUri = await writeDocument("passing.json", passing.bytes);
  const failingUri = await writeDocument("failing.json", failing.bytes);
  const tamperedUri = await writeDocument(
    "tampered.json",
    canonicalBytes({
      ...(passing.document as Record<string, unknown>),
      artifact: { ...(passing.document["artifact"] as Record<string, unknown>), observedAt: 1_790_000_999 },
    } as unknown as CanonicalValue),
  );

  // A runner that publishes only the evidence artifact, with none of the
  // documents the receipt's other hashes commit to.
  const bareArtifact = buildArtifact({ result: "PASS" });
  const bareBytes = canonicalBytes(bareArtifact as unknown as CanonicalValue);
  const bareUri = await writeDocument("bare-artifact.json", bareBytes);

  published["pass"] = await publish(
    buildReceiptFields({ evidenceHash: passing.hash, passed: true }),
    passingUri,
  );
  published["bare"] = await publish(
    buildReceiptFields({ evidenceHash: keccak256(toHex(bareBytes)), passed: true }),
    bareUri,
  );
  published["fail"] = await publish(
    buildReceiptFields({ evidenceHash: failing.hash, passed: false }),
    failingUri,
  );
  // Commits to the honest bundle's hash but serves altered bytes.
  published["tampered"] = await publish(
    buildReceiptFields({ evidenceHash: passing.hash, passed: true }),
    tamperedUri,
  );
  // Claims a pass on chain while the evidence it points at records a failure.
  published["contradictory"] = await publish(
    buildReceiptFields({ evidenceHash: failing.hash, passed: true }),
    failingUri,
  );

  mandates["withinScope"] = await activate(published["pass"], GRANTED_AUTHORITY_HASH);
  mandates["overbroad"] = await activate(published["pass"], OVERBROAD_AUTHORITY_HASH);

  // One activation per lifecycle state, each on its own account so the mandate
  // ids do not collide and each account can answer differently.
  const holdsKey = returningCode(accountAnswer([SESSION_KEY_HASH]));
  const holdsNothing = returningCode(accountAnswer([]));
  await setCode(anvil.rpcUrl, LIVE_ACCOUNT, holdsKey);
  await setCode(anvil.rpcUrl, CONTRADICTORY_ACCOUNT, holdsKey);
  await setCode(anvil.rpcUrl, REVOKED_ACCOUNT, holdsNothing);
  await setCode(anvil.rpcUrl, VANISHED_ACCOUNT, holdsNothing);
  await setCode(anvil.rpcUrl, LAPSED_ACCOUNT, holdsNothing);

  mandates["live"] = await activate(published["pass"], GRANTED_AUTHORITY_HASH, { wallet: LIVE_ACCOUNT });
  mandates["revoked"] = await activate(published["pass"], GRANTED_AUTHORITY_HASH, {
    wallet: REVOKED_ACCOUNT,
  });
  mandates["vanished"] = await activate(published["pass"], GRANTED_AUTHORITY_HASH, {
    wallet: VANISHED_ACCOUNT,
  });
  mandates["lapsed"] = await activate(published["pass"], GRANTED_AUTHORITY_HASH, {
    wallet: LAPSED_ACCOUNT,
    validUntil: GRANT_CLOSED_UNTIL,
  });
  mandates["contradictory"] = await activate(published["pass"], GRANTED_AUTHORITY_HASH, {
    wallet: CONTRADICTORY_ACCOUNT,
  });

  await recordRevocation(mandates["revoked"] as Hex);
  await recordRevocation(mandates["contradictory"] as Hex);

  // One action inside the grant, one refused by the enforcement layer. Anvil
  // hosts no Altana account, so the refusal comes from bytecode that emits the
  // account's own custom error.
  await setCode(
    anvil.rpcUrl,
    SPEND_CAP_REVERTER,
    revertingCode(
      encodeErrorResult({
        abi: ACCOUNT_ERROR_ABI,
        errorName: "ExceededSpendLimit",
        args: ["0x3333333333333333333333333333333333333333"],
      }),
    ),
  );
  executions["allowed"] = await sendFromWallet(GRANTED_TARGET, parseEther("0.01"));
  executions["blocked"] = await sendFromWallet(SPEND_CAP_REVERTER, 0n);
}, 120_000);

afterAll(async () => {
  await anvil?.stop();
});

describe("client configuration", () => {
  it("refuses an RPC that serves a different chain than the one requested", async () => {
    // #given an endpoint for chain 31337 while chain 97 was asked for
    // #when a client is created
    // #then it fails loudly, because receipt ids commit to the chain id and every
    //      recomputation would otherwise fail and blame the publisher
    await expect(
      createClient({
        chainId: 97,
        rpcUrl: anvil.rpcUrl,
        registry: anvil.registry,
        networkName: "BSC Testnet",
        registrySource: "test harness",
      }),
    ).rejects.toThrow(/serves chain 31337/);
  });
});

describe("verify:trial against a published receipt", () => {
  it("verifies a passing receipt from chain plus evidence alone", async () => {
    // #given a receipt published to the registry with a full disclosure bundle
    // #when verified with nothing but an RPC and the evidence URI
    const report = await run(published["pass"] as Hex);

    // #then every trial step holds and the verdict is unqualified
    expect(report.steps.map((step) => step.status)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    expect(report.verdict).toBe("VERIFIED");
    expect(report.receipt?.publisher).toBe(anvil.deployer);
  });

  it("recomputes the receipt id from the stored fields rather than trusting the lookup", async () => {
    // #given a published receipt
    // #when verified
    const report = await run(published["pass"] as Hex);

    // #then the id check names what it re-derived
    expect(statusOf(report, "trial receipt")).toBe("PASS");
    expect(reasonOf(report, "trial receipt")).toContain("recomputes from its own fields");
  });

  it("verifies a receipt that records a FAIL, because the record is what is being checked", async () => {
    // #given an honestly published failing trial
    // #when verified
    const report = await run(published["fail"] as Hex);

    // #then the record verifies even though the agent did not pass
    expect(report.verdict).toBe("VERIFIED");
    expect(report.receipt?.passed).toBe(false);
    expect(statusOf(report, "reference result")).toBe("PASS");
  });

  it("fails an unknown receipt id instead of reporting an empty success", async () => {
    // #given an id that was never published
    const unknown = keccak256(toHex("never-published")) as Hex;

    // #when verified
    const report = await run(unknown);

    // #then the verdict is FAILED and the reason names the registry it asked
    expect(report.verdict).toBe("FAILED");
    expect(statusOf(report, "trial receipt")).toBe("FAIL");
    expect(reasonOf(report, "trial receipt")).toContain(anvil.registry);
  });

  it("fails on an evidence hash mismatch, and reads nothing out of the document", async () => {
    // #given a receipt whose evidence URI serves altered bytes
    // #when verified
    const report = await run(published["tampered"] as Hex);

    // #then the hash check fails and every evidence-dependent step is skipped, not guessed
    expect(report.verdict).toBe("FAILED");
    expect(statusOf(report, "evidence hash")).toBe("FAIL");
    expect(reasonOf(report, "evidence hash")).toContain("evidence hash mismatch");
    expect(statusOf(report, "reference result")).toBe("SKIP");
    expect(statusOf(report, "tested authority")).toBe("SKIP");
    expect(reasonOf(report, "tested authority")).toContain("failed its hash check");
  });

  it("fails a receipt whose on-chain result contradicts its own evidence", async () => {
    // #given a receipt published as a pass over evidence that records a failure
    // #when verified
    const report = await run(published["contradictory"] as Hex);

    // #then the contradiction is reported rather than resolved in the publisher's favour
    expect(report.verdict).toBe("FAILED");
    expect(statusOf(report, "reference result")).toBe("FAIL");
    expect(reasonOf(report, "reference result")).toContain("contradicts the receipt");
  });

  it("degrades honestly when the evidence URI serves only the artifact", async () => {
    // #given a receipt whose evidence is a bare artifact, with no TrialSpec or AuthorityIR
    // #when verified
    const report = await run(published["bare"] as Hex);

    // #then the run itself still verifies, and the undisclosed steps say what is missing
    expect(statusOf(report, "evidence hash")).toBe("PASS");
    expect(statusOf(report, "reference result")).toBe("PASS");
    expect(statusOf(report, "agent version")).toBe("SKIP");
    expect(statusOf(report, "tested authority")).toBe("SKIP");
    expect(reasonOf(report, "tested authority")).toContain("discloses no AuthorityIR");
    expect(report.verdict).toBe("PARTIALLY VERIFIED");
    expect(report.notes.join(" ")).toContain("bare evidence artifact");
  });

  it("reports STALE once the receipt is past its freshness horizon", async () => {
    // #given a receipt that checks out in every respect
    // #when verified after freshUntil
    const report = await run(published["pass"] as Hex, { now: 1_800_000_000 });

    // #then expiry leads the verdict rather than being buried in a field
    expect(report.verdict).toBe("STALE");
    expect(report.steps.every((step) => step.status === "PASS")).toBe(true);
  });

  it("prints the PRD §89 step list with a reason on every line", async () => {
    // #given a verified receipt
    const report = await run(published["pass"] as Hex);

    // #when rendered for a terminal
    const text = renderReport(report);

    // #then each step and the verdict are legible without a legend
    for (const step of report.steps) expect(text).toContain(step.id);
    expect(text).toContain("VERDICT");
    expect(text).toContain("VERIFIED");
    expect(text).not.toMatch(/^\s*$/);
  });
});

describe("verify:mandate against an activation", () => {
  it("checks the granted authority against the chain and re-runs the subset comparator", async () => {
    // #given a mandate activated with a grant that only tightens the tested envelope
    const disclosure = await writeDocument(
      "granted-within.json",
      canonicalBytes(buildMandateDisclosure(GRANTED_AUTHORITY) as unknown as CanonicalValue),
    );

    // #when verified with that disclosure
    const report = await verifyMandate(mandates["withinScope"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
      disclosureUri: disclosure,
    });

    // #then the grant matches the on-chain hash and the relation is recomputed locally
    expect(statusOf(report, "granted authority")).toBe("PASS");
    expect(statusOf(report, "subset relation")).toBe("PASS");
    expect(reasonOf(report, "subset relation")).toContain("granted ⊆ tested");
    expect(report.mandate?.sequence).toBe(0);
  });

  it("refuses to verify a grant that is not within what was tested", async () => {
    // #given a mandate activated with double the tested daily spend
    const disclosure = await writeDocument(
      "granted-overbroad.json",
      canonicalBytes(buildMandateDisclosure(OVERBROAD_AUTHORITY) as unknown as CanonicalValue),
    );

    // #when verified
    const report = await verifyMandate(mandates["overbroad"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
      disclosureUri: disclosure,
    });

    // #then the comparator's own rule name is reported, and the verdict is FAILED
    expect(report.verdict).toBe("FAILED");
    expect(statusOf(report, "granted authority")).toBe("PASS");
    expect(statusOf(report, "subset relation")).toBe("FAIL");
    expect(reasonOf(report, "subset relation")).toContain("granted-spend-limit-not-greater");
  });

  it("rejects a disclosure that does not hash to the activation's commitment", async () => {
    // #given a disclosure holding a different grant than the one on chain
    const disclosure = await writeDocument(
      "granted-swapped.json",
      canonicalBytes(buildMandateDisclosure(OVERBROAD_AUTHORITY) as unknown as CanonicalValue),
    );

    // #when checked against a mandate activated with the narrow grant
    const report = await verifyMandate(mandates["withinScope"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
      disclosureUri: disclosure,
    });

    // #then the substitution is caught before the document is used for anything
    expect(report.verdict).toBe("FAILED");
    expect(statusOf(report, "granted authority")).toBe("FAIL");
    expect(reasonOf(report, "granted authority")).toContain("not the one the mandate was activated with");
    expect(statusOf(report, "subset relation")).toBe("SKIP");
  });

  it("skips the grant steps with a stated reason when no disclosure is supplied", async () => {
    // #given only a mandate id, with nothing handed over off chain
    // #when verified
    const report = await verifyMandate(mandates["withinScope"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
    });

    // #then the verifier attempts the URI the activation records rather than
    // demanding a flag, and names precisely why that attempt did not yield a
    // document. An unreadable disclosure is a gap to state, never a failure of
    // the mandate itself.
    expect(report.verdict).toBe("PARTIALLY VERIFIED");
    expect(statusOf(report, "granted authority")).toBe("SKIP");
    expect(reasonOf(report, "granted authority")).toContain("could not be read");
    expect(report.notes.join(" ")).toContain("resolved from the disclosureURI");
  });

  it("skips session and execution steps when the wallet holds no account code", async () => {
    // #given a wallet address that is not an account contract on this chain
    // #when verified
    const report = await verifyMandate(mandates["withinScope"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
    });

    // #then the report says what could not be read rather than assuming it was fine
    expect(statusOf(report, "session registration")).toBe("SKIP");
    expect(reasonOf(report, "session registration")).toContain("no account code");
    expect(statusOf(report, "allowed execution")).toBe("SKIP");
    expect(statusOf(report, "blocked execution")).toBe("SKIP");
    expect(report.steps).toHaveLength(12);
  });

  it("confirms both executions from chain, and separates a policy block from a fault", async () => {
    // #given a disclosure naming one permitted action and one refused action
    const disclosure = await writeDocument(
      "with-executions.json",
      canonicalBytes({
        ...buildMandateDisclosure(GRANTED_AUTHORITY),
        session: { wallet, keyHash: SESSION_KEY_HASH },
        allowedExecutions: [{ txHash: executions["allowed"], label: "repay 20 USDT" }],
        blockedExecutions: [{ txHash: executions["blocked"], label: "repay 6 more USDT" }],
      } as unknown as CanonicalValue),
    );

    // #when verified
    const report = await verifyMandate(mandates["withinScope"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
      disclosureUri: disclosure,
    });

    // #then both executions check out, and only the session read is out of reach
    expect(statusOf(report, "allowed execution")).toBe("PASS");
    expect(statusOf(report, "blocked execution")).toBe("PASS");
    expect(report.executions.find((entry) => entry.label === "repay 6 more USDT")?.revert?.name).toBe(
      "ExceededSpendLimit",
    );
    // `rejected intents` skips because this disclosure names reverted
    // transactions rather than intents the account refused before broadcast.
    // The two are different guarantees and are checked by different steps.
    expect(report.steps.filter((step) => step.status !== "PASS").map((step) => step.id)).toEqual([
      "session registration",
      "rejected intents",
    ]);
    expect(report.verdict).toBe("PARTIALLY VERIFIED");
  });

  it("refuses a disclosure whose blocked transaction actually succeeded", async () => {
    // #given a disclosure that calls a successful transfer a blocked action
    const disclosure = await writeDocument(
      "false-block.json",
      canonicalBytes({
        ...buildMandateDisclosure(GRANTED_AUTHORITY),
        blockedExecutions: [{ txHash: executions["allowed"], label: "claimed to be blocked" }],
      } as unknown as CanonicalValue),
    );

    // #when verified
    const report = await verifyMandate(mandates["withinScope"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
      disclosureUri: disclosure,
    });

    // #then the false claim is reported rather than counted as the boundary holding
    expect(report.verdict).toBe("FAILED");
    expect(statusOf(report, "blocked execution")).toBe("FAIL");
    expect(reasonOf(report, "blocked execution")).toContain("SUCCEEDED");
  });

  it("reconstructs a revoked grant from the activation instead of calling it unverifiable", async () => {
    // #given a mandate whose session was revoked, so its account holds no key
    // #when verified with nothing but the chain
    const report = await verifyMandate(mandates["revoked"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
    });

    // #then the window and the revocation are read off the record, which is the
    // whole reason they were committed to it: an empty account no longer has to
    // stand for "nothing was ever granted here"
    expect(statusOf(report, "session registration")).toBe("PASS");
    expect(reasonOf(report, "session registration")).toContain("revoked");
    const detail = report.steps.find((step) => step.id === "session registration")?.detail ?? {};
    expect(detail["granted from"]).toBe(new Date(Number(GRANT_VALID_FROM) * 1000).toISOString());
    expect(detail["valid until"]).toBe(new Date(Number(GRANT_VALID_UNTIL) * 1000).toISOString());
    expect(detail["revoked at"]).not.toBe("none");
    expect(report.mandate?.revokedAt).toBeGreaterThan(0);
  });

  it("checks a live session against the account and the window it was granted over", async () => {
    // #given a mandate the registry records no revocation for
    // #when verified against an account that still holds the key
    const report = await verifyMandate(mandates["live"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
    });

    // #then the account corroborates the record rather than replacing it
    expect(statusOf(report, "session registration")).toBe("PASS");
    expect(reasonOf(report, "session registration")).toContain("the account itself holds this key");
    expect(report.mandate?.revokedAt).toBe(0);
  });

  it("reports a key that vanished inside its own window rather than papering over it", async () => {
    // #given an activation with no revocation on record and a window still open
    // #when the account turns out to hold no such key
    const report = await verifyMandate(mandates["vanished"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
    });

    // #then the contradiction is the finding. The record claims live authority
    // the enforcement layer is not holding, and softening that to "could not be
    // checked" would hide the one state a reader must not miss
    expect(statusOf(report, "session registration")).toBe("FAIL");
    expect(reasonOf(report, "session registration")).toContain("no revocation");
    expect(report.verdict).toBe("FAILED");
  });

  it("accepts a window that simply closed, because that is what the record predicts", async () => {
    // #given a mandate whose window ended before the verification time
    // #when the account holds no key
    const report = await verifyMandate(mandates["lapsed"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
    });

    // #then nothing is wrong: an expired grant leaving an empty account is the
    // record coming true, and failing it would make every finished mandate
    // look broken
    expect(statusOf(report, "session registration")).toBe("PASS");
    expect(reasonOf(report, "session registration")).toContain("window closed");
  });

  it("fails when the registry says revoked while the account still holds the key", async () => {
    // #given a revocation recorded against an account that never gave the key up
    // #when verified
    const report = await verifyMandate(mandates["contradictory"] as Hex, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
    });

    // #then the record is not allowed to declare authority dead that is still
    // enforceable
    expect(statusOf(report, "session registration")).toBe("FAIL");
    expect(reasonOf(report, "session registration")).toContain("still holds a key");
  });

  it("fails a mandate id the registry has no activation for", async () => {
    // #given an id that was never activated
    const unknown = keccak256(toHex("never-activated")) as Hex;

    // #when verified
    const report = await verifyMandate(unknown, {
      target,
      client: anvil.publicClient,
      now: NOW_WITHIN_FRESHNESS,
    });

    // #then it fails instead of returning a report about an empty record
    expect(report.verdict).toBe("FAILED");
    expect(statusOf(report, "trial receipt")).toBe("FAIL");
  });
});

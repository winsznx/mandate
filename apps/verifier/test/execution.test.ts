/**
 * The distinction the headline proof rests on.
 *
 * MANDATE's demo ends with a transaction that fails. A failed transaction on
 * its own proves nothing — the interesting question is what refused it. These
 * tests put a real spend-cap rejection and a convincing impostor on the same
 * chain and require the verifier to tell them apart.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeErrorResult, keccak256, parseEther, toHex } from "viem";
import type { Address, Hex } from "viem";
import { ACCOUNT_ERROR_ABI } from "@mandate/altana";
import { checkAllowedExecution, checkBlockedExecution } from "../src/execution.js";
import type { ExecutionContext } from "../src/execution.js";
import { revertingCode, setCode, startAnvilWithRegistry } from "./anvil.js";
import type { AnvilHandle } from "./anvil.js";

const SPEND_CAP_REVERTER = "0x00000000000000000000000000000000000000A1" as Address;
const ALLOWANCE_REVERTER = "0x00000000000000000000000000000000000000A2" as Address;
const RECIPIENT = "0x00000000000000000000000000000000000000A3" as Address;
const TOKEN = "0x3333333333333333333333333333333333333333" as Address;

let anvil: AnvilHandle;
let context: ExecutionContext;

async function send(to: Address, value: bigint): Promise<Hex> {
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

beforeAll(async () => {
  anvil = await startAnvilWithRegistry();

  // The account's own rejection, and the ERC-20 allowance failure that
  // impersonates it most convincingly.
  await setCode(
    anvil.rpcUrl,
    SPEND_CAP_REVERTER,
    revertingCode(
      encodeErrorResult({ abi: ACCOUNT_ERROR_ABI, errorName: "ExceededSpendLimit", args: [TOKEN] }),
    ),
  );
  await setCode(
    anvil.rpcUrl,
    ALLOWANCE_REVERTER,
    revertingCode(
      encodeErrorResult({
        abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
        errorName: "Error",
        args: ["ERC20: transfer amount exceeds allowance"],
      }),
    ),
  );

  // The deployer stands in for the mandate's wallet, so `from` links the
  // transactions to the mandate the way a direct session call would.
  context = { wallet: anvil.deployer, grantedTargets: new Set([RECIPIENT]) };
}, 120_000);

afterAll(async () => {
  await anvil?.stop();
});

describe("checkAllowedExecution", () => {
  it("confirms a successful transaction that touches the mandate's wallet", async () => {
    // #given a transaction the wallet sent to a granted target
    const hash = await send(RECIPIENT, parseEther("0.01"));

    // #when checked against chain
    const finding = await checkAllowedExecution(anvil.publicClient, context, { txHash: hash, label: "repay" });

    // #then it is confirmed and tied to the mandate
    expect(finding.status).toBe("CONFIRMED");
    expect(finding.linkedToMandate).toBe(true);
  });

  it("will not accept a transaction that reverted as a permitted action", async () => {
    // #given a transaction that failed
    const hash = await send(SPEND_CAP_REVERTER, 0n);

    // #when checked
    const finding = await checkAllowedExecution(anvil.publicClient, context, { txHash: hash, label: "repay" });

    // #then it is reported as a rejection rather than as evidence of a permitted action
    expect(finding.status).toBe("REJECTED");
    expect(finding.summary).toContain("does not demonstrate a permitted action");
  });

  it("reports a transaction that does not exist rather than assuming it does", async () => {
    // #given a hash that was never mined
    const hash = keccak256(toHex("no-such-transaction")) as Hex;

    // #when checked
    const finding = await checkAllowedExecution(anvil.publicClient, context, { txHash: hash, label: "repay" });

    // #then nothing is invented
    expect(finding.status).toBe("NOT_FOUND");
  });
});

describe("checkBlockedExecution", () => {
  it("attributes a spend-cap rejection to the enforcement layer", async () => {
    // #given a call the account refused with ExceededSpendLimit
    const hash = await send(SPEND_CAP_REVERTER, 0n);

    // #when checked
    const finding = await checkBlockedExecution(anvil.publicClient, context, {
      txHash: hash,
      label: "repay 6 more USDT",
    });

    // #then the refusal is attributed, with the contract-level error named
    expect(finding.status).toBe("REJECTED");
    expect(finding.revert?.name).toBe("ExceededSpendLimit");
    expect(finding.revert?.class).toBe("POLICY_BLOCKED");
    expect(finding.revert?.token).toBe(TOKEN.toLowerCase());
  });

  it("refuses to pass off an allowance failure as a policy block", async () => {
    // #given a revert that looks identical from the outside but is a misconfiguration
    const hash = await send(ALLOWANCE_REVERTER, 0n);

    // #when checked
    const finding = await checkBlockedExecution(anvil.publicClient, context, {
      txHash: hash,
      label: "repay 6 more USDT",
    });

    // #then it is not counted as the boundary holding
    expect(finding.status).toBe("UNATTRIBUTABLE");
    expect(finding.revert?.class).toBe("ALLOWANCE_INSUFFICIENT");
    expect(finding.summary).toContain("not by the enforcement layer");
  });

  it("rejects a disclosure that points at a transaction which actually succeeded", async () => {
    // #given a transaction the disclosure calls blocked but which went through
    const hash = await send(RECIPIENT, parseEther("0.01"));

    // #when checked
    const finding = await checkBlockedExecution(anvil.publicClient, context, {
      txHash: hash,
      label: "should have been blocked",
    });

    // #then the contradiction is stated plainly
    expect(finding.status).toBe("CONFIRMED");
    expect(finding.summary).toContain("SUCCEEDED");
  });
});

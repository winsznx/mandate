/**
 * Scenarios: the deterministic setup a trial runs on top of.
 *
 * Every step is either a labelled modification of forked state or a real
 * transaction against the forked protocol, and the two are recorded
 * differently. That distinction is the honesty boundary of the whole artifact.
 * A verifier reading the evidence has to be able to tell "this account borrowed
 * through Venus, here is the transaction" from "this balance was written into
 * storage by the harness", because the second one is only as trustworthy as the
 * label attached to it.
 *
 * `SIMULATED ORACLE SHOCK` is the canonical example. It is a legitimate way to
 * put a position under stress and a completely illegitimate thing to leave
 * unlabelled, so the modification carries the human-facing label, the anvil
 * method that performed it, and the slot it wrote.
 */
import type { Address, Hex } from "viem";
import type { StateModification } from "@mandate/domain";
import { TrialInfrastructureError } from "./errors.js";
import { forkRpc, type ForkHandle } from "./anvil.js";

/**
 * One setup step.
 *
 * `CALL` is not a modification. It goes through the protocol's own code paths
 * and produces a transaction with a receipt, so it appears in the artifact's
 * transaction list under `SCENARIO_SETUP` rather than in the modification list.
 */
export type ScenarioStep =
  | { readonly kind: "FUND_GAS"; readonly account: Address; readonly wei: bigint; readonly label: string }
  | { readonly kind: "IMPERSONATE"; readonly account: Address; readonly label: string }
  | {
      readonly kind: "SET_STORAGE";
      readonly target: Address;
      readonly slot: Hex;
      readonly value: Hex;
      readonly label: string;
    }
  | {
      readonly kind: "SET_ORACLE_PRICE";
      readonly oracle: Address;
      readonly slot: Hex;
      readonly priceMantissa: bigint;
      readonly label: string;
    }
  | { readonly kind: "SET_CODE"; readonly target: Address; readonly code: Hex; readonly label: string }
  | { readonly kind: "MINE_BLOCKS"; readonly count: number; readonly label: string }
  | {
      readonly kind: "CALL";
      readonly from: Address;
      readonly to: Address;
      readonly data: Hex;
      readonly value: bigint;
      readonly label: string;
    };

export interface TrialScenario {
  readonly scenarioId: string;
  readonly version: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  /** Pin the fork here. Omitted means head-pinned, which the artifact records as `live`. */
  readonly blockNumber?: bigint;
  /** Permit degrading to a head-pinned fork when the RPC has pruned the pinned state. */
  readonly allowHeadFallback: boolean;
  /** The position under test. */
  readonly account: Address;
  /** The single market the agent holds authority to act in. */
  readonly actionableMarket: Address;
  readonly setup: readonly ScenarioStep[];
}

/** A transaction the harness sent, before the agent was asked anything. */
export interface SetupTransaction {
  readonly hash: Hex;
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly label: string;
}

export interface ScenarioApplication {
  readonly modifications: readonly StateModification[];
  readonly setupTransactions: readonly SetupTransaction[];
}

function toQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

async function sendAndWait(
  fork: ForkHandle,
  step: Extract<ScenarioStep, { kind: "CALL" }>,
): Promise<SetupTransaction> {
  const hash = await forkRpc<Hex>(fork, "eth_sendTransaction", [
    {
      from: step.from,
      to: step.to,
      data: step.data,
      value: toQuantity(step.value),
    },
  ]);

  const receipt = await forkRpc<{ status: Hex } | null>(fork, "eth_getTransactionReceipt", [hash]);
  if (receipt === null) {
    throw new TrialInfrastructureError(
      "SCENARIO_SETUP_FAILED",
      `no receipt for setup transaction ${hash}`,
    );
  }
  if (BigInt(receipt.status) !== 1n) {
    // A reverted setup transaction means the trial never reached the state it
    // meant to test. Continuing would evaluate the agent against a position
    // that is not the one the scenario describes.
    throw new TrialInfrastructureError(
      "SCENARIO_SETUP_FAILED",
      `setup transaction "${step.label}" reverted (${hash})`,
    );
  }

  return { hash, from: step.from, to: step.to, data: step.data, value: step.value, label: step.label };
}

/**
 * Run a scenario's setup against a live fork.
 *
 * Steps run in order and the whole thing fails closed: a step that does not do
 * what it said leaves the fork in a state the scenario does not describe, and
 * the only safe response is to abandon the trial rather than evaluate an agent
 * against a position nobody specified.
 */
export async function applyScenario(
  fork: ForkHandle,
  scenario: TrialScenario,
): Promise<ScenarioApplication> {
  const modifications: StateModification[] = [];
  const setupTransactions: SetupTransaction[] = [];

  for (const step of scenario.setup) {
    switch (step.kind) {
      case "FUND_GAS": {
        await forkRpc(fork, "anvil_setBalance", [step.account, toQuantity(step.wei)]);
        modifications.push({
          label: step.label,
          kind: "FUND_GAS",
          target: step.account,
          rpcMethod: "anvil_setBalance",
          detail: `balance set to ${step.wei} wei so the account can pay for gas on the fork`,
        });
        break;
      }

      case "IMPERSONATE": {
        await forkRpc(fork, "anvil_impersonateAccount", [step.account]);
        modifications.push({
          label: step.label,
          kind: "IMPERSONATE",
          target: step.account,
          rpcMethod: "anvil_impersonateAccount",
          detail:
            "the harness sends on this account's behalf without its key; no signature was produced and none is claimed",
        });
        break;
      }

      case "SET_STORAGE": {
        await forkRpc(fork, "anvil_setStorageAt", [step.target, step.slot, step.value]);
        modifications.push({
          label: step.label,
          kind: "SET_STORAGE",
          target: step.target,
          rpcMethod: "anvil_setStorageAt",
          detail: `slot ${step.slot} written to ${step.value}`,
        });
        break;
      }

      case "SET_ORACLE_PRICE": {
        const value = `0x${step.priceMantissa.toString(16).padStart(64, "0")}` as Hex;
        await forkRpc(fork, "anvil_setStorageAt", [step.oracle, step.slot, value]);
        modifications.push({
          label: step.label,
          kind: "SET_ORACLE_PRICE",
          target: step.oracle,
          rpcMethod: "anvil_setStorageAt",
          detail: `slot ${step.slot} written to ${step.priceMantissa}; this price did not come from the oracle's own feeds`,
        });
        break;
      }

      case "SET_CODE": {
        await forkRpc(fork, "anvil_setCode", [step.target, step.code]);
        modifications.push({
          label: step.label,
          kind: "SET_CODE",
          target: step.target,
          rpcMethod: "anvil_setCode",
          detail: `runtime bytecode replaced with ${step.code.length / 2 - 1} bytes; this contract is no longer the deployed one`,
        });
        break;
      }

      case "MINE_BLOCKS": {
        await forkRpc(fork, "anvil_mine", [toQuantity(BigInt(step.count))]);
        modifications.push({
          label: step.label,
          kind: "MINE_BLOCKS",
          // Mining is not scoped to an address. The zero address stands for the
          // chain itself rather than for a contract that was touched.
          target: "0x0000000000000000000000000000000000000000",
          rpcMethod: "anvil_mine",
          detail: `${step.count} blocks mined, advancing accrued interest`,
        });
        break;
      }

      case "CALL": {
        setupTransactions.push(await sendAndWait(fork, step));
        break;
      }
    }
  }

  return { modifications, setupTransactions };
}

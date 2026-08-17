/**
 * Where the verifier is allowed to get its bearings.
 *
 * These tests exist to keep one property honest: the only inputs are flags,
 * environment variables and a committed deployment record. If a lookup service
 * ever creeps in here, the whole "no MANDATE infrastructure" claim goes with it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ConfigurationError, DEFAULT_CHAIN_ID, DEFAULT_RPC_URLS, resolveTarget } from "../src/config.js";

const ENV_KEYS = ["MANDATE_CHAIN_ID", "MANDATE_RPC_URL", "MANDATE_REGISTRY_ADDRESS"] as const;
const REGISTRY = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("resolveTarget", () => {
  it("defaults to BSC testnet and its public node", () => {
    // #given only an explicit registry, so no deployment record is needed
    // #when resolved
    const target = resolveTarget({ registry: REGISTRY });

    // #then MANDATE's first deployment target is the default
    expect(target.chainId).toBe(DEFAULT_CHAIN_ID);
    expect(target.rpcUrl).toBe(DEFAULT_RPC_URLS[DEFAULT_CHAIN_ID]);
    expect(target.networkName).toBe("BSC Testnet");
  });

  it("normalises the registry address so comparisons never hinge on checksum casing", () => {
    // #given a checksummed address
    // #when resolved
    const target = resolveTarget({ registry: REGISTRY });

    // #then it is stored lowercase, as every canonical document stores addresses
    expect(target.registry).toBe(REGISTRY.toLowerCase());
  });

  it("lets a flag override the environment", () => {
    // #given an environment pointing somewhere else
    process.env["MANDATE_RPC_URL"] = "https://from-environment.example";

    // #when a flag is supplied
    const target = resolveTarget({ registry: REGISTRY, rpcUrl: "https://from-flag.example" });

    // #then the flag wins, so an operator can always redirect the verifier
    expect(target.rpcUrl).toBe("https://from-flag.example");
  });

  it("reads the environment when no flag is given", () => {
    // #given an environment-configured endpoint and registry
    process.env["MANDATE_RPC_URL"] = "https://from-environment.example";
    process.env["MANDATE_REGISTRY_ADDRESS"] = REGISTRY;

    // #when resolved with no flags
    const target = resolveTarget();

    // #then both are honoured and the source is recorded for the report
    expect(target.rpcUrl).toBe("https://from-environment.example");
    expect(target.registrySource).toBe("MANDATE_REGISTRY_ADDRESS");
  });

  it("explains how to proceed when no deployment record exists for the chain", () => {
    // #given a chain MANDATE has never deployed to
    // #when resolved with no registry override
    // #then the error names the missing file and the two ways around it
    expect(() => resolveTarget({ chainId: 8453, rpcUrl: "https://example" })).toThrow(ConfigurationError);
    expect(() => resolveTarget({ chainId: 8453, rpcUrl: "https://example" })).toThrow(
      /contracts\/deployments\/8453\.json/,
    );
  });

  it("refuses a chain with no default endpoint rather than guessing one", () => {
    // #given a chain outside the known set and no RPC flag
    // #when resolved
    // #then it asks instead of inventing a host
    expect(() => resolveTarget({ chainId: 8453, registry: REGISTRY })).toThrow(/no default RPC/);
  });
});

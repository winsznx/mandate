import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAddress, toFunctionSelector } from "viem";
import * as adapter from "../src/index.js";
import {
  EXCHANGE_RECEIVER_SELECTOR,
  EXCHANGE_RECEIVER_SIGNATURE,
  EXCHANGE_SELECTOR,
  EXCHANGE_SIGNATURE,
  STABLESWAP_BSC_TESTNET,
  STABLESWAP_POOL_ABI,
  isFullyRead,
  stableswapDeploymentFor,
  unreadableReadings,
  type RawStableswapObservation,
} from "../src/index.js";

/**
 * The property that makes this package safe for both sides of a trial to share.
 *
 * The agent and the reference model both read from here. That is only sound
 * because what they get is facts: balances, rates, parameters and the pool's own
 * quote, with no judgement attached. The moment this package exports a price, a
 * rung or a trade size, the two implementations stop being independent and a
 * bug in the shared function makes the agent wrong and its judge agree.
 *
 * `@mandate/venus-bsc` carries the same assertion for the same reason.
 */

const SOURCE = new URL("../src/", import.meta.url);

function sources(): { name: string; content: string }[] {
  const directory = fileURLToPath(SOURCE);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => ({
      name: entry.name,
      content: readFileSync(fileURLToPath(new URL(entry.name, SOURCE)), "utf8"),
    }));
}

describe("the adapter holds no opinion", () => {
  it("exports no pricing, no ladder and no trade sizing", () => {
    // #given the package's whole public surface
    const exported = Object.keys(adapter);

    // #then nothing on it answers a question the two sides are meant to answer
    // separately. This is the assertion that licenses both of them to depend on
    // this package at all.
    for (const forbidden of [
      "computePrice",
      "solveInvariant",
      "getInvariant",
      "quoteSwap",
      "fairRate",
      "rungFor",
      "sizeTrade",
      "isCheap",
    ]) {
      expect(exported).not.toContain(forbidden);
    }
  });

  it("contains no invariant solver anywhere in its source", () => {
    // #given every source file in this package
    const files = sources();
    expect(files.length).toBeGreaterThan(3);

    // #then none of them iterates toward a curve. A shared solver would be one
    // implementation wearing two names, and the comparison the trial rests on
    // would be a restatement.
    for (const file of files) {
      expect(file.content).not.toMatch(/Newton|newton/);
      expect(file.content).not.toMatch(/for\s*\(\s*let\s+\w+\s*=\s*0[^)]*255/);
    }
  });

  it("records the pool's own quote without doing arithmetic on it", () => {
    // #given the module that reads the chain
    const reads = sources().find((file) => file.name === "reads.ts");
    expect(reads).toBeDefined();

    // #then the quote reaches the observation as a decimal string of exactly
    // what `get_dy` returned. `poolQuotes` is data: the package states what the
    // pool said and leaves both sides to decide whether to believe it — the
    // agent does, and the reference model reconstructs it instead.
    expect(reads?.content).toMatch(/dy: dy\.toString\(10\)/);
    // Matched against declarations rather than free text, because the comments
    // in these files necessarily name the concepts they refuse to compute.
    expect(reads?.content).not.toMatch(/(?:function|const|let)\s+(?:deviation|rung|slippage|price)/);
  });
});

describe("the deployment record is internally consistent", () => {
  it("carries lowercase addresses, so a document hash does not depend on casing", () => {
    // #given every address in the configured deployment
    const addresses = [
      STABLESWAP_BSC_TESTNET.pool,
      ...STABLESWAP_BSC_TESTNET.coins.map((coin) => coin.token),
    ];

    // #then all of them are valid and already normalised
    for (const address of addresses) {
      expect(isAddress(address, { strict: false })).toBe(true);
      expect(address).toBe(address.toLowerCase());
    }
  });

  it("indexes its coins by their position in the pool", () => {
    // #given the configured coin list
    // #then the declared index matches the array position. `exchange` takes coin
    // indices and nothing else, so an off-by-one here is a trade in the wrong
    // direction rather than a cosmetic error.
    STABLESWAP_BSC_TESTNET.coins.forEach((coin, position) => {
      expect(coin.index).toBe(position);
    });
  });

  it("refuses a chain it has no deployment for", () => {
    // #given a chain id nothing is configured for
    // #then it throws rather than returning a partially-filled record that
    // would send a trade to the zero address
    expect(() => stableswapDeploymentFor(56)).toThrow(/no stableswap deployment/);
  });
});

describe("the selectors are the ones the signatures produce", () => {
  it("derives the boundable exchange selector from its signature", () => {
    // #given the signature the agent card publishes
    // #then the selector the permission set carries is the one it hashes to. A
    // hand-copied selector that drifts from the signature would mean the card
    // and the grant describe different functions.
    expect(toFunctionSelector(EXCHANGE_SIGNATURE)).toBe(EXCHANGE_SELECTOR);
  });

  it("derives the receiver-taking variant's selector from its signature", () => {
    // #given the five-argument sibling that is never granted
    expect(toFunctionSelector(EXCHANGE_RECEIVER_SIGNATURE)).toBe(EXCHANGE_RECEIVER_SELECTOR);
  });

  it("keeps the two apart", () => {
    // #then the whole safety argument rests on these being different functions,
    // so the artifact has to be able to tell them apart
    expect(EXCHANGE_SELECTOR).not.toBe(EXCHANGE_RECEIVER_SELECTOR);
  });

  it("exposes only the boundable variant in the ABI it hands out", () => {
    // #given the pool ABI this package exports
    const names = STABLESWAP_POOL_ABI.map((entry) => entry.name);

    // #then `exchange` appears once, as the four-argument form. A consumer
    // cannot reach the receiver-taking variant through this adapter by accident.
    expect(names.filter((name) => name === "exchange")).toHaveLength(1);
    const exchange = STABLESWAP_POOL_ABI.find((entry) => entry.name === "exchange");
    expect(exchange?.inputs.map((input) => input.type)).toEqual([
      "int128",
      "int128",
      "uint256",
      "uint256",
    ]);
  });

  it("carries no is_killed fragment", () => {
    // #given the pool ABI
    // #then `is_killed()` is absent. It exists on older Curve pools and reverts
    // on stableswap-ng, and a consumer holding the fragment would have to decide
    // what a revert means — both readings being wrong, one refusing to trade a
    // live pool and the other guessing.
    expect(STABLESWAP_POOL_ABI.map((entry) => entry.name)).not.toContain("is_killed");
  });
});

describe("an incomplete reading is unknown, never zero", () => {
  const complete: RawStableswapObservation = {
    schemaVersion: "mandate.stableswap-observation/1",
    chainId: 97,
    account: "0x1111111111111111111111111111111111111111",
    blockNumber: "125936215",
    blockHash: `0x${"ab".repeat(32)}`,
    pool: STABLESWAP_BSC_TESTNET.pool,
    amplification: "100",
    feeBase: "1000000",
    offpegFeeMultiplier: "20000000000",
    virtualPrice: "1000000004561277297",
    coins: STABLESWAP_BSC_TESTNET.coins.map((coin) => ({
      index: coin.index,
      token: coin.token,
      symbol: coin.symbol,
      decimals: coin.decimals,
      reportedDecimals: coin.decimals,
      poolBalance: "1000",
      storedRate: "1000000000000000000",
      walletBalance: "0",
      walletAllowance: "0",
    })),
    poolQuotes: [],
  };

  it("accepts a fully-read observation", () => {
    // #given every reading present
    expect(isFullyRead(complete)).toBe(true);
    expect(unreadableReadings(complete)).toEqual([]);
  });

  it("rejects an observation missing a stored rate, and names it", () => {
    // #given a coin whose rate could not be read
    const partial: RawStableswapObservation = {
      ...complete,
      coins: complete.coins.map((coin, index) =>
        index === 0 ? { ...coin, storedRate: null } : coin,
      ),
    };

    // #then the absence is reported rather than defaulted. A pool priced from
    // the balances that did arrive is the price of a different pool.
    expect(isFullyRead(partial)).toBe(false);
    expect(unreadableReadings(partial).join(" ")).toMatch(/stored_rates/);
  });

  it("rejects an observation missing the amplification, and names it", () => {
    // #given a pool that did not answer `A()`
    const partial: RawStableswapObservation = { ...complete, amplification: null };

    expect(isFullyRead(partial)).toBe(false);
    expect(unreadableReadings(partial)).toContain("A()");
  });

  it("rejects an observation missing the off-peg multiplier", () => {
    // #given a pool that did not answer `offpeg_fee_multiplier()`
    const partial: RawStableswapObservation = { ...complete, offpegFeeMultiplier: null };

    // #then it is unreadable. The multiplier scales the fee as the pool leaves
    // balance, so a consumer that defaulted it would over-quote every swap in
    // the direction that makes a trade look profitable when it is not.
    expect(isFullyRead(partial)).toBe(false);
    expect(unreadableReadings(partial)).toContain("offpeg_fee_multiplier()");
  });
});

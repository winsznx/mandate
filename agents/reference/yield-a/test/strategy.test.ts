import { describe, expect, it } from "vitest";
import type { AgentExecutor, Proposal } from "@mandate/agent-runtime";
import type { Address } from "viem";
import { COST_AWARE_OPTIMIZER_POLICY, describePolicy } from "../src/policy.js";
import { createYieldStrategy } from "../src/strategy.js";
import { MINT_SELECTOR, VENUS_SUPPLY_BSC_TESTNET } from "../src/venus/index.js";
import type { SupplyAccountState } from "../src/venus/reader.js";
import {
  ACCOUNT,
  BLOCK,
  USDC_PRICE_6DP,
  USDT_PRICE_6DP,
  VUSDC,
  VUSDT,
  fixedReader,
  market,
  position,
  retiredBusd,
  state,
} from "./fixtures.js";

const REQUEST = {
  requestId: "req-1",
  skill: "optimise-yield",
  chainId: 97,
  wallet: ACCOUNT,
  parameters: {},
} as const;

const USDT_UNDERLYING = "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c" as Address;
const USDC_UNDERLYING = "0x16227d60f7a0e586c66b005219dfc887d13c9531" as Address;

function strategy(accountState: SupplyAccountState): AgentExecutor {
  return createYieldStrategy({
    slug: "yield-a",
    displayName: "Cost-Aware Optimizer",
    description: "Fixture.",
    policy: COST_AWARE_OPTIMIZER_POLICY,
    deployment: VENUS_SUPPLY_BSC_TESTNET,
    reader: fixedReader(accountState),
  });
}

function propose(accountState: SupplyAccountState): Promise<Proposal> {
  return strategy(accountState).propose(REQUEST);
}

function amountOf(proposal: Proposal): bigint {
  if (proposal.decision !== "PROPOSE") throw new Error(`expected PROPOSE, got ${proposal.decision}`);
  return BigInt(proposal.action.args[0]?.value ?? "-1");
}

describe("the card the marketplace publishes", () => {
  it("registers under the YIELD category with the skill a trial harness calls", () => {
    // #given the wired executor
    const executor = strategy(position({ annualRateBps: 120, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 0n }));

    // #then it is discoverable in the right category, under the id the adapter routes on
    expect(executor.category).toBe("YIELD");
    expect(executor.slug).toBe("yield-a");
    expect(executor.skills.map((skill) => skill.id)).toEqual(["optimise-yield"]);
  });

  it("publishes the action it proposes by signature, not by verb", () => {
    // #given the published policy document
    const published = describePolicy(COST_AWARE_OPTIMIZER_POLICY) as Record<string, unknown>;

    // #then a reader can tell mint(uint256) from mintBehalf(address,uint256),
    // which is the difference between a grantable action and an unbounded one
    expect(published["action"]).toBe("mint(uint256)");
    expect(published["policyId"]).toBe("cost-aware-optimizer");
  });

  it("publishes the annualisation convention alongside the floor it gates on", () => {
    // #given the published policy document
    const published = describePolicy(COST_AWARE_OPTIMIZER_POLICY) as Record<string, unknown>;

    // #then a reader disagreeing with the convention can see which one produced
    // the rate, rather than having to infer it from the result
    expect(published["blocksPerYear"]).toBe(COST_AWARE_OPTIMIZER_POLICY.blocksPerYear);
    expect(published["rateSource"]).toBe("vToken.supplyRatePerBlock");
  });
});

describe("deploying idle capital", () => {
  it("proposes a mint into the market paying the best net rate", async () => {
    // #given USDC paying 300 bps against USDT's 120, with idle balances in both
    const proposal = await propose(
      position(
        { annualRateBps: 120, walletBalance: 1_000_000_000n },
        { annualRateBps: 300, walletBalance: 1_000_000_000n },
      ),
    );

    // #then the capital goes to USDC, through mint(uint256), sized at the whole
    // idle balance because nothing else binds
    expect(proposal.decision).toBe("PROPOSE");
    if (proposal.decision !== "PROPOSE") return;
    expect(proposal.action.target).toBe(VUSDC);
    expect(proposal.action.selector).toBe(MINT_SELECTOR);
    expect(proposal.action.args).toEqual([{ type: "uint256", value: "1000000000" }]);
  });

  it("proposes one argument and nothing that names a recipient", async () => {
    // #given any state that produces an action
    const proposal = await propose(
      position(
        { annualRateBps: 120, walletBalance: 1_000_000_000n },
        { annualRateBps: 300, walletBalance: 1_000_000_000n },
      ),
    );

    // #then the calldata is a selector and a size. There is no address in it to
    // constrain, which is the whole reason this action is grantable under
    // (target, selector) permissions with no guard.
    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");
    expect(proposal.action.args).toHaveLength(1);
    expect(proposal.action.args.every((argument) => argument.type === "uint256")).toBe(true);
  });

  it("switches markets when the rates switch", async () => {
    // #given the same state with the rates the other way round
    const proposal = await propose(
      position(
        { annualRateBps: 300, walletBalance: 1_000_000_000n },
        { annualRateBps: 120, walletBalance: 1_000_000_000n },
      ),
    );

    // #then the choice follows the rate rather than the market ordering
    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");
    expect(proposal.action.target).toBe(VUSDT);
  });

  it("records the block it reasoned about, so a trial can check its freshness", async () => {
    // #given any deliberation
    const proposal = await propose(
      position({ annualRateBps: 120, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 1_000_000_000n }),
    );

    // #then the observation names the block. On BSC a block arrives every
    // 0.45 s, so an agent answering from a different one may be right about a
    // position that no longer exists.
    const observations = proposal.observations as Record<string, unknown>;
    expect(observations["blockNumber"]).toBe(BLOCK.toString(10));
  });
});

describe("the floors that stop it churning", () => {
  it("holds when the best market does not clear the net rate floor", async () => {
    // #given both markets paying 80 bps gross, which is 55 bps net of the
    // 25 bps cost buffer, against a 75 bps floor
    const proposal = await propose(
      position(
        { annualRateBps: 80, walletBalance: 1_000_000_000n },
        { annualRateBps: 80, walletBalance: 1_000_000_000n },
      ),
    );

    // #then the capital stays idle
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/below the 75 bps floor/);
  });

  it("acts at the boundary rate and holds one basis point below it", async () => {
    // #given the exact gross rate at which the net figure equals the floor
    const atBoundary = await propose(
      position({ annualRateBps: 0, walletBalance: 0n }, { annualRateBps: 100, walletBalance: 1_000_000_000n }),
    );
    const belowBoundary = await propose(
      position({ annualRateBps: 0, walletBalance: 0n }, { annualRateBps: 99, walletBalance: 1_000_000_000n }),
    );

    // #then the comparison is inclusive at the line and exclusive below it.
    // A policy that says "at least 75 bps" has to act at 75 bps, or the
    // published number is not the number the agent uses.
    expect(atBoundary.decision).toBe("PROPOSE");
    expect(belowBoundary.decision).toBe("HOLD");
  });

  it("holds when the deployable size is below the minimum size floor", async () => {
    // #given a good rate but only 5 USDC of idle balance, against a $10 floor
    const proposal = await propose(
      position({ annualRateBps: 0, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 5_000_000n }),
    );

    // #then the transaction is not worth making
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/below the 10\.00 USD floor/);
  });

  it("prices the size floor in dollars rather than in token units", async () => {
    // #given 15 units of each token: 15 USDC is $15 and clears the $10 floor,
    // 15 USDT is $7.50 at the testnet price of fifty cents and does not
    const usdcOnly = await propose(
      position({ annualRateBps: 0, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 15_000_000n }),
    );
    const usdtOnly = await propose(
      position({ annualRateBps: 300, walletBalance: 15_000_000n }, { annualRateBps: 0, walletBalance: 0n }),
    );

    // #then identical token amounts produce opposite decisions, because the
    // floor is a dollar floor and the two tokens are not worth the same
    expect(usdcOnly.decision).toBe("PROPOSE");
    expect(usdtOnly.decision).toBe("HOLD");
  });
});

describe("markets that will not take a deposit", () => {
  it("never proposes into a market with mint paused, even holding its token", async () => {
    // #given BUSD paying 5000 bps — far above either live market — with mint
    // paused and a supply cap of zero exactly as chain 97 holds it, and 1000
    // BUSD sitting idle in the wallet ready to deploy
    const withRetiredHoldings = state([
      market({
        vToken: VUSDC,
        underlying: USDC_UNDERLYING,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: USDC_PRICE_6DP,
        annualRateBps: 300,
        walletBalance: 1_000_000_000n,
      }),
      retiredBusd(1_000n * 10n ** 18n),
    ]);

    // #when the strategy ranks the board
    const proposal = await propose(withRetiredHoldings);

    // #then the best rate on it is ignored, because the call would revert.
    // Filtering on `isListed` alone would have picked BUSD: it is listed.
    if (proposal.decision !== "PROPOSE") throw new Error("expected an action");
    expect(proposal.action.target).toBe(VUSDC);
  });

  it("sizes down to the market's remaining supply cap", async () => {
    // #given a market already holding 0.2 units — `totalSupply * exchangeRate`
    // is `1e9 * 2e14 / 1e18` — under a cap that leaves room for exactly 400
    // more, against an idle balance of 1000
    const capped = state([
      market({
        vToken: VUSDC,
        underlying: USDC_UNDERLYING,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: USDC_PRICE_6DP,
        annualRateBps: 300,
        walletBalance: 1_000_000_000n,
        totalSupplyVTokens: 10n ** 9n,
        exchangeRateMantissa: 2n * 10n ** 14n,
        supplyCapRaw: 200_000n + 400_000_000n,
      }),
      retiredBusd(),
    ]);

    // #when the strategy sizes the deployment
    const proposal = await propose(capped);

    // #then it asks for the headroom rather than the balance. A proposal above
    // the cap is not a bolder strategy, it is a call that reverts.
    expect(amountOf(proposal)).toBe(400_000_000n);
  });

  it("sizes down to the allowance the admin key granted", async () => {
    // #given a wallet holding 1000 but having approved only 250
    const limited = state([
      market({
        vToken: VUSDC,
        underlying: USDC_UNDERLYING,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: USDC_PRICE_6DP,
        annualRateBps: 300,
        walletBalance: 1_000_000_000n,
        allowance: 250_000_000n,
      }),
      retiredBusd(),
    ]);

    // #then the proposal stays inside what the account will actually let the
    // vToken pull. The session cannot grant this approval; only the admin key can.
    expect(amountOf(await propose(limited))).toBe(250_000_000n);
  });

  it("holds when there is no allowance at all", async () => {
    // #given idle capital and a good rate but nothing approved
    const unapproved = state([
      market({
        vToken: VUSDC,
        underlying: USDC_UNDERLYING,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: USDC_PRICE_6DP,
        annualRateBps: 300,
        walletBalance: 1_000_000_000n,
        allowance: 0n,
      }),
      retiredBusd(),
    ]);

    // #then it holds rather than proposing a mint that would revert on transferFrom
    expect((await propose(unapproved)).decision).toBe("HOLD");
  });

  it("holds when there is nothing idle to deploy", async () => {
    // #given every balance already supplied
    const proposal = await propose(
      position({ annualRateBps: 120, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 0n }),
    );

    // #then there is no action to take, and it says so rather than proposing zero
    expect(proposal.decision).toBe("HOLD");
  });
});

describe("refusing on state it could not reconstruct", () => {
  it("holds when a market's implementation has moved off the pin", async () => {
    // #given a vToken whose delegator now points at different code
    const moved = state([
      market({
        vToken: VUSDC,
        underlying: USDC_UNDERLYING,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: USDC_PRICE_6DP,
        annualRateBps: 300,
        walletBalance: 1_000_000_000n,
        implementation: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Address,
      }),
    ]);

    // #then it refuses. "Bounded by target and selector" is only as strong as
    // the governance timelock that can replace the code behind the proxy.
    const proposal = await propose(moved);
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/implementation has moved/);
  });

  it("holds when any market could not be fully read", async () => {
    // #given one market whose reads failed, alongside a perfectly good one
    const partial = state([
      market({
        vToken: VUSDC,
        underlying: USDC_UNDERLYING,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: USDC_PRICE_6DP,
        annualRateBps: 300,
        walletBalance: 1_000_000_000n,
      }),
      market({
        vToken: VUSDT,
        underlying: USDT_UNDERLYING,
        symbol: "USDT",
        underlyingDecimals: 6,
        priceMantissa: USDT_PRICE_6DP,
        annualRateBps: 120,
        walletBalance: 1_000_000_000n,
        unreadableReason: "supplyRatePerBlock(): connection reset",
      }),
    ]);

    // #then it refuses rather than ranking the markets it could read. The
    // unreadable one might have been the best, and answering over the readable
    // subset answers a different question from the one asked.
    const proposal = await propose(partial);
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/could not be read/);
  });

  it("holds when a token reports different decimals than it was configured with", async () => {
    // #given USDC configured at 6 decimals but reporting 18
    const misdeclared = state([
      market({
        vToken: VUSDC,
        underlying: USDC_UNDERLYING,
        symbol: "USDC",
        underlyingDecimals: 6,
        reportedDecimals: 18,
        priceMantissa: USDC_PRICE_6DP,
        annualRateBps: 300,
        walletBalance: 1_000_000_000n,
      }),
    ]);

    // #then it refuses. The oracle scale is 1e(36 - decimals), so the two
    // readings differ by twelve orders of magnitude rather than by a rounding.
    const proposal = await propose(misdeclared);
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/different decimals/);
  });

  it("holds when an oracle price cannot be right for the decimals it was read with", async () => {
    // #given a 6-decimal token quoted at the 18-decimal scale, which is the
    // exact shape of the testnet decimal trap
    const mispriced = state([
      market({
        vToken: VUSDC,
        underlying: USDC_UNDERLYING,
        symbol: "USDC",
        underlyingDecimals: 6,
        priceMantissa: 10n ** 18n,
        annualRateBps: 300,
        walletBalance: 1_000_000_000n,
      }),
    ]);

    // #then it refuses rather than sizing a deployment against a price that
    // implies the token is worth a millionth of a cent
    const proposal = await propose(mispriced);
    expect(proposal.decision).toBe("HOLD");
    if (proposal.decision !== "HOLD") return;
    expect(proposal.rationale).toMatch(/not consistent with its decimals/);
  });
});

describe("the executor never executes", () => {
  it("returns a proposal and touches no signer", async () => {
    // #given the executor's whole public surface
    const executor = strategy(
      position({ annualRateBps: 0, walletBalance: 0n }, { annualRateBps: 300, walletBalance: 1_000_000_000n }),
    );

    // #then the only method that acts is `propose`, and what it returns is a
    // description of a call rather than a call. The deterministic layer decides
    // whether it is permitted; nothing an agent returns can widen its authority.
    expect(Object.keys(executor).filter((key) => typeof (executor as Record<string, unknown>)[key] === "function")).toEqual([
      "propose",
    ]);
  });
});

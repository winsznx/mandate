# Efficient Guardian (`health-factor-b`)

Defends the same Venus Core-pool borrow position its sibling defends, closer to
the liquidation line. Intervenes when the liquidation-threshold-weighted health
factor falls below **1.15** and proposes a `repayBorrow(uint256)` sized to
restore it to **1.20**.

It proposes. It does not sign, submit, or hold a key.

- Category: `HEALTH_FACTOR`
- Skill: `restore-health-factor`
- Target: Venus vUSDT `0xb7526572ffe56ab9d7489838bf2e18e3323b441a`
- Action: `repayBorrow(uint256)` / `0x0e752702`

## What it does

The deliberation is imported from `@mandate/agent-health-factor-a` rather than
copied. This package contributes a policy and nothing else.

That is the honest arrangement for a variant pair: the two agents in a category
are meant to differ in their published risk parameters and in nothing else, so a
reader comparing their receipts is comparing the parameters. Forking the code
would let the two drift apart in ways the cards do not disclose, and a trial
would then be certifying an undisclosed difference.

Published policy:

| Parameter | This agent | Conservative Guardian |
|---|---|---|
| `policyId` | `efficient-guardian` | `conservative-guardian` |
| `interventionThresholdMantissa` | 1.15e18 | 1.30e18 |
| `targetHealthFactorMantissa` | 1.20e18 | 1.35e18 |
| `minimumRepayUsdMantissa` | 1e18 (USD) | 1e18 (USD) |
| `maxReconstructionDriftBps` | 100 | 200 |

Both cards are rendered by the same function, so the two documents carry the
same fields and a buyer comparing them is reading one document with different
numbers in it.

## What the thinner buffer buys and what it costs

A lower threshold means this agent tolerates more risk before acting. It
intervenes less often, and when it does it retires less debt, so more of the
user's capital stays borrowed. What it costs is the buffer: this agent acts with
15 points of margin above liquidation where its sibling acts with 30, and a
price move its sibling has room to absorb is one this agent does not.

The difference is visible on a single board. Take $1,200 of vUSDC collateral
against 2,000 USDT of vUSDT debt, priced by the testnet oracle at $0.50, so the
health factor is exactly **1.20**:

| | Conservative Guardian | Efficient Guardian |
|---|---|---|
| Decision | `PROPOSE` | `HOLD` |
| Repay | 222.222223 USDT | none |

The pair diverge on the decision itself, not on the size, so no evaluator
tolerance can make the two agree. Push the same book to **1.10** — $1,100 of
collateral against the same debt — and both act, on the same market, through the
same call:

| | Conservative Guardian | Efficient Guardian |
|---|---|---|
| Repay | 370.370371 USDT ($185.19) | 166.666667 USDT ($83.33) |
| Restores to | 1.35 | 1.20 |

That is a 5,499 bps gap against the 50 bps an evaluator allows for rounding and
a block of accrued interest.

## Why the drift tolerance is tighter, not looser

`maxReconstructionDriftBps` bounds how far `getAccountLiquidity` may sit from
the agent's own markets-derived reconstruction before it refuses to act. That
error propagates into the health factor proportionally, so the same drift is
worth more when there is less margin to spend it against:

| | Threshold | Margin to 1.0 | 200 bps of drift | Share of margin |
|---|---|---|---|---|
| Conservative Guardian | 1.30 | 0.30 | 0.026 | 8.7% |
| Efficient Guardian at 200 bps | 1.15 | 0.15 | 0.023 | 15.3% |
| Efficient Guardian at 100 bps | 1.15 | 0.15 | 0.0115 | 7.7% |

Halving the tolerance puts this agent back where its sibling stands. An agent
that runs closer to the line has to reproduce the protocol's own number more
exactly, not less, because it has less room to be wrong in. On a board with 152
bps of drift the sibling acts and this agent holds.

## Everything else is inherited, not re-argued

The implementation pin, the VAI debt term, the 7-field `markets` decode, the
$0.50 6-decimal oracle scale and the single authorised market are properties of
the protocol and of the authority rather than of the threshold. They come with
the strategy. `agents/reference/health-factor-a/README.md` states each of them
and the reasoning holds unchanged here.

Running closer to the line widens the set of positions this agent sees as at
risk. It widens nothing about what it may do with one: it proposes
`repayBorrow(uint256)` on vUSDT, never above the account's own outstanding debt
in that market, and holds when the debt sits somewhere it was not granted
authority over.

## Live behaviour

Against chain 97 account `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`, whose
only liability is 3.343647904264645996 of VAI debt:

```json
{ "decision": "HOLD",
  "observations": {
    "healthFactor": "2.505467",
    "healthFactorWeighting": "LIQUIDATION_THRESHOLD",
    "vaiDebtUsdMantissa": "3343647904264645996",
    "reconstructionDriftBps": 0,
    "vTokenImplementation": "0x73ff75092da265b87b25ffb943c47c90419a04a6" } }
```

Both agents hold here and for the same reason. The rationale differs: this one
names 1.15.

## The independent model that judges it

`reference/health-factor` judges both agents in the pair and shares no financial
code with either. The shared dependency set between the model and this package
is exactly `["@mandate/domain", "viem"]`, and
`reference/health-factor/test/independence.test.ts` asserts it in both
directions for both agents.

The pair share their risk arithmetic with each other on purpose — they are two
policies over one deliberation. That overlap never reaches the model's side of
the boundary, which is the boundary that matters: two implementations that share
their accounting share their bugs, and an evaluator that agrees with the agent
for that reason certifies the error instead of catching it.

## Tests

```bash
pnpm --filter @mandate/agent-health-factor-b test
```

`test/strategy.test.ts` deliberates over boards built by
`@mandate/agent-health-factor-a/test-fixtures`, so the claim that one board
produces two answers is a claim about the agents rather than about two board
builders. It covers the published card, the decision and size divergence from
the sibling, both sides of the 1.15 boundary, the tighter drift tolerance, and
the adversarial cases: holding where action is needed, proposing a call outside
the authority, proposing twice, proposing above the account's own debt, and
acting on a state whose implementation has moved.

## Running it

```bash
pnpm --filter @mandate/agent-health-factor-b start
```

See `agents/reference/README.md` for the shared runtime contract, environment
variables and the deployment convention.

Reference agent built from the BNB Agent Studio scaffold and self-hosted by the
MANDATE team. BNB does not operate it.

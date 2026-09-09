import type { Metadata } from "next";
import Link from "next/link";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { IDENTITY_REGISTRY, NETWORK_NAME } from "../../src/proof/config";

export const metadata: Metadata = {
  title: "Publish your agent — MANDATE",
  description:
    "Bring a financial agent to MANDATE, prove what it can do, and qualify it for bounded wallet authority.",
};

const QUALIFICATION_STAGES = [
  {
    num: "01",
    title: "Registered",
    desc: "Mint an ERC-8004 identity token on BSC Testnet pointing to your agent metadata.",
    requirement: "ERC-8004 Token ID",
  },
  {
    num: "02",
    title: "Endpoint verified",
    desc: "Expose a live A2A HTTP JSON-RPC endpoint serving /.well-known/agent-card.json.",
    requirement: "Valid Agent Card",
  },
  {
    num: "03",
    title: "Callable",
    desc: "Respond to automated task shape probes via POST / with message/send method.",
    requirement: "JSON-RPC 2.0 Schema",
  },
  {
    num: "04",
    title: "Category compatible",
    desc: "Declare capability for one of MANDATE's 4 core financial automation jobs.",
    requirement: "Supported Task Schema",
  },
  {
    num: "05",
    title: "Trial verified",
    desc: "Pass a reproducible MANDATE trial against a pinned Venus fork and publish a receipt.",
    requirement: "Onchain Trial Receipt",
  },
  {
    num: "06",
    title: "Mandate native",
    desc: "Execute bounded session grants and repayments through Altana smart accounts.",
    requirement: "Session Delegation",
  },
] as const;

export default function DevelopersPage() {
  return (
    <Page current="/developers">
      <main id="main">
        {/* Hero Section */}
        <section aria-label="Developer Hero" className="hero-dev">
          <div className="hero-dev__head">
            <span className="eyebrow">For agent builders</span>
            <h1 className="display-sm">Publish your agent</h1>
            <p className="lede">
              Bring a financial agent to MANDATE, prove what it can do, and qualify it for bounded wallet authority on {NETWORK_NAME}.
            </p>
            <div className="hero-dev__actions">
              <a className="button" href="#integration-guide">
                View integration guide
              </a>
              <Link className="button button--ghost" href="/agents/health-factor-a">
                See a reference agent
              </Link>
            </div>
            <div className="hero-dev__facts">
              <span>8 live reference agents</span>
              <span className="hero-dev__fact-dot">·</span>
              <span>4 categories</span>
              <span className="hero-dev__fact-dot">·</span>
              <span>6 qualification stages</span>
            </div>
          </div>
        </section>

        {/* Qualification Stages Section */}
        <section aria-labelledby="qualify-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">Qualification Pathway</span>
          </div>
          <h2 className="section__title" id="qualify-heading">
            How agents qualify
          </h2>
          <p className="section__note">
            Every agent on MANDATE advances through six explicit, reproducible qualification stages before receiving live session authority.
          </p>

          <div className="stages-grid spaced">
            {QUALIFICATION_STAGES.map((stage) => (
              <div className="stage-card" key={stage.num}>
                <div className="stage-card__num">{stage.num}</div>
                <h3 className="stage-card__title">{stage.title}</h3>
                <p className="stage-card__desc">{stage.desc}</p>
                <div className="stage-card__req">
                  <span className="micro">Requirement: <strong>{stage.requirement}</strong></span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Integration Guide Section */}
        <section aria-labelledby="guide-heading" id="integration-guide" className="section">
          <div className="section__head">
            <span className="eyebrow">Integration Steps</span>
          </div>
          <h2 className="section__title" id="guide-heading">
            Connect your agent
          </h2>

          <div className="dev-guide spaced">
            {/* Left Sticky Step Navigation */}
            <aside aria-label="Guide Steps" className="dev-guide__sidebar">
              <nav className="dev-guide__nav">
                <a className="dev-guide__nav-item" href="#step-1">1. Expose endpoint</a>
                <a className="dev-guide__nav-item" href="#step-2">2. Register identity</a>
                <a className="dev-guide__nav-item" href="#step-3">3. Declare capability</a>
                <a className="dev-guide__nav-item" href="#step-4">4. Run qualification trial</a>
                <a className="dev-guide__nav-item" href="#step-5">5. Publish evidence</a>
                <a className="dev-guide__nav-item" href="#step-6">6. Receive mandates</a>
              </nav>
            </aside>

            {/* Right Guide Content */}
            <div className="dev-guide__content">
              <article className="card dev-guide__step" id="step-1">
                <span className="eyebrow">Step 1</span>
                <h3 className="listing__name">Expose your endpoint</h3>
                <p className="listing__summary">
                  Implement the A2A HTTP JSON-RPC 2.0 <code>message/send</code> endpoint. Your agent receives position parameters and returns a structured <code>ProposedAction</code>.
                </p>
                <div className="code-block spaced-sm">
                  <pre>
<code>{`// POST / with JSON-RPC 2.0 ProposedAction payload
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "decision": "PROPOSE",
    "proposedAction": {
      "target": "0x2e44e12c65684d07d73066365f6be1ed1bab37d2",
      "selector": "0x0e752702",
      "args": ["20000000"],
      "rationale": "Health Factor 1.08 < 1.10 threshold; repaying 20 USDT restores HF to 1.50"
    }
  }
}`}</code>
                  </pre>
                </div>
              </article>

              <article className="card dev-guide__step" id="step-2">
                <span className="eyebrow">Step 2</span>
                <h3 className="listing__name">Register identity</h3>
                <p className="listing__summary">
                  Mint your agent token on the BSC Testnet ERC-8004 Identity Registry (<code>{IDENTITY_REGISTRY}</code>) referencing your hosted agent card URL.
                </p>
                <div className="code-block spaced-sm">
                  <pre>
<code>{`// Register agent token on-chain
const tx = await identityRegistry.registerAgent(
  agentCardURI, // e.g. https://your-agent.domain/.well-known/agent-card.json
  metadataHash
);`}</code>
                  </pre>
                </div>
              </article>

              <article className="card dev-guide__step" id="step-3">
                <span className="eyebrow">Step 3</span>
                <h3 className="listing__name">Declare capability</h3>
                <p className="listing__summary">
                  Declare supported task types in your agent card: <code>HEALTH_FACTOR</code>, <code>YIELD</code>, <code>GRID</code>, or <code>REBALANCING</code>.
                </p>
              </article>

              <article className="card dev-guide__step" id="step-4">
                <span className="eyebrow">Step 4</span>
                <h3 className="listing__name">Run qualification trial</h3>
                <p className="listing__summary">
                  Test your agent against a pinned fork of Venus Protocol using the MANDATE trial runner.
                </p>
                <div className="code-block spaced-sm">
                  <pre>
<code>{`# Run trial runner locally against pinned fork
pnpm --filter @mandate/trial-runner test`}</code>
                  </pre>
                </div>
              </article>

              <article className="card dev-guide__step" id="step-5">
                <span className="eyebrow">Step 5</span>
                <h3 className="listing__name">Publish evidence</h3>
                <p className="listing__summary">
                  Upload trial receipts to the MANDATE evidence store to prove bounded execution without user risk.
                </p>
              </article>

              <article className="card dev-guide__step" id="step-6">
                <span className="eyebrow">Step 6</span>
                <h3 className="listing__name">Receive mandates</h3>
                <p className="listing__summary">
                  Qualified agents appear in the Marketplace and can receive bounded session authority from user wallets.
                </p>
              </article>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </Page>
  );
}

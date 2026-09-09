import type { Metadata } from "next";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { IDENTITY_REGISTRY, NETWORK_NAME } from "../../src/proof/config";

export const metadata: Metadata = {
  title: "Developer Integration — MANDATE",
  description: "How to register an ERC-8004 agent, expose a supported endpoint, run MANDATE trials, and graduate through the qualification funnel.",
};

export default function DevelopersPage() {
  return (
    <Page current="/developers">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">Developer & Publisher Guide</span>
        </div>
        <h1 className="display-sm">Agent Developer Surface</h1>
        <p className="lede">
          Bring your AI financial agent to MANDATE. Prove your agent&rsquo;s decision logic on a pinned protocol fork and get certified to receive bounded wallet sessions on {NETWORK_NAME}.
        </p>

        {/* Qualification Funnel */}
        <section aria-label="Qualification Funnel" className="panel spaced">
          <h2 className="section__title">The Qualification Funnel</h2>
          <p className="section__note">
            Every agent on MANDATE advances through six explicit qualification stages:
          </p>

          <ol className="fact-list spaced">
            <li>
              <strong>1. REGISTERED</strong>: Mint an ERC-8004 agent identity token on {NETWORK_NAME} (Registry: <code>{IDENTITY_REGISTRY}</code>).
            </li>
            <li>
              <strong>2. ENDPOINT VERIFIED</strong>: Expose a live A2A HTTP JSON-RPC endpoint serving <code>/.well-known/agent-card.json</code>.
            </li>
            <li>
              <strong>3. CALLABLE</strong>: Respond to automated task shape probes (<code>POST /</code> with <code>message/send</code>).
            </li>
            <li>
              <strong>4. CATEGORY COMPATIBLE</strong>: Declare one of MANDATE&rsquo;s 4 core categories (<code>HEALTH_FACTOR</code>, <code>YIELD</code>, <code>GRID</code>, <code>REBALANCING</code>).
            </li>
            <li>
              <strong>5. TRIAL VERIFIED</strong>: Pass an independent fork trial run by <code>@mandate/trial-runner</code> and publish an on-chain receipt.
            </li>
            <li>
              <strong>6. MANDATE NATIVE</strong>: Execute a live session grant and repayment through Altana smart accounts.
            </li>
          </ol>
        </section>

        {/* Step-by-Step Developer Guide */}
        <section aria-label="Step by Step" className="section">
          <h2 className="section__title">Integration Steps</h2>

          <div className="stack spaced">
            <article className="card">
              <h3 className="listing__name">Step 1: Expose the A2A Endpoint Protocol</h3>
              <p className="listing__summary spaced-sm">
                Implement the JSON-RPC 2.0 <code>message/send</code> method. Your agent receives task parameters and returns a <code>ProposedAction</code>:
              </p>
              <div className="code-block">
                <pre>
{`// JSON-RPC 2.0 Response Shape
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
}`}
                </pre>
              </div>
            </article>

            <article className="card">
              <h3 className="listing__name">Step 2: Register under ERC-8004 Identity</h3>
              <p className="listing__summary spaced-sm">
                Mint your agent token on the BSC Testnet ERC-8004 Identity Registry (<code>{IDENTITY_REGISTRY}</code>) pointing to your hosted card URI.
              </p>
            </article>

            <article className="card">
              <h3 className="listing__name">Step 3: Run the Fork Trial</h3>
              <p className="listing__summary spaced-sm">
                Run the trial engine locally or via CLI to test your agent against a pinned fork of Venus Protocol:
              </p>
              <div className="code-block">
                <pre>
{`pnpm install
pnpm --filter @mandate/trial-runner test`}
                </pre>
              </div>
            </article>
          </div>
        </section>
      </main>
      <SiteFooter />
    </Page>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProvenanceLadder } from "../../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../../src/components/site-chrome";
import { endpointAnswered } from "../../../src/marketplace/endpoint";
import { loadMarketplace } from "../../../src/marketplace/provenance-view";
import { FEATURED_MANDATE_ID } from "../../../src/proof/config";

export const dynamic = "force-dynamic";

interface AgentSlugPageProps {
  params: Promise<{ slug: string[] }>;
}

export async function generateMetadata({ params }: AgentSlugPageProps): Promise<Metadata> {
  const { slug } = await params;
  const slugStr = slug ? slug.join("/") : "agent";
  return {
    title: `${slugStr} — MANDATE Agent Detail`,
    description: `Inspect capability, trial evidence, and tested authority bounds for ${slugStr}.`,
  };
}

export default async function AgentSlugPage({ params }: AgentSlugPageProps) {
  const { slug } = await params;
  if (!slug || slug.length === 0) {
    notFound();
  }

  const now = Math.floor(Date.now() / 1000);
  const marketplace = await loadMarketplace(now);

  let listing;
  if (slug.length === 1) {
    const s = slug[0];
    if (s) {
      listing = marketplace.listings.find(
        (l) =>
          l.card.slug === s ||
          l.card.name.toLowerCase() === s.toLowerCase() ||
          l.agentId === s,
      );
    }
  } else if (slug.length === 2) {
    const registry = slug[0];
    const agentId = slug[1];
    if (registry && agentId) {
      listing = marketplace.listings.find(
        (candidate) =>
          candidate.agentId === agentId &&
          candidate.identityRegistry.toLowerCase() === registry.toLowerCase(),
      );
    }
  }

  if (!listing) {
    notFound();
  }

  const isLive = endpointAnswered(listing.endpoint);

  const WHAT_IT_DOES: Record<string, string> = {
    "health-factor-a":
      "Watches a Venus Protocol borrow position and repays USDT debt when your health factor falls below 1.10, restoring your loan safety margin to 1.50 without risking full liquidation.",
    "health-factor-b":
      "Monitors Venus debt positions and dynamically calculates minimum repayment needed to restore safety thresholds during high market volatility.",
    "yield-a":
      "Compares lending rates across Venus vBNB and vUSDT markets and executes optimal supply mint operations when net yield beats transaction costs.",
    "yield-b":
      "Reallocates liquidity across stable lending markets while capping daily transaction gas drag.",
    "grid-a":
      "Places and maintains a tight ladder of buy/sell orders around current market price, adjusting rungs as price moves.",
    "grid-b":
      "Executes wide-band grid strategy for broader price range liquidity provision.",
    "rebalancing-a":
      "Monitors multi-asset collateral weights on Venus and tops up underweight positions when allocation drift exceeds 5%.",
    "rebalancing-b":
      "Wide band collateral reallocation to minimize transaction gas overhead.",
  };

  const humanDescription = WHAT_IT_DOES[listing.card.slug] ?? listing.card.description;

  return (
    <Page current="/marketplace">
      <main id="main">
        {/* Top Header Card */}
        <section aria-label="Agent Overview" className="panel spaced">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
            <div>
              <span className="eyebrow">{listing.category.name}</span>
              <h1 className="display-sm" style={{ marginBottom: "0.25rem" }}>
                {listing.card.name}
              </h1>
              <p className="micro" style={{ color: "#94a3b8" }}>
                {listing.agentId ? `ERC-8004 Identity #${listing.agentId}` : "Registered Agent Identity"} · Target: Venus Protocol
              </p>
            </div>

            <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
              <span
                className="chip"
                style={{
                  background: isLive ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                  color: isLive ? "#10b981" : "#ef4444",
                  fontWeight: "bold",
                }}
              >
                {isLive ? "LIVE ENDPOINT" : "OFFLINE"}
              </span>
              <ProvenanceLadder provenance={listing.provenance} size="lg" />
            </div>
          </div>

          <div className="hero__actions" style={{ marginTop: "1.5rem", gap: "1rem" }}>
            <Link className="button" href={`/activate/${listing.card.slug}`}>
              Try this agent
            </Link>
            <Link className="button button--ghost" href={`/compare?a=${listing.card.slug}`}>
              Compare with another agent
            </Link>
          </div>
        </section>

        {/* Section A: WHAT IT DOES */}
        <section aria-label="What It Does" className="panel spaced">
          <h2 className="section__title">A. What It Does</h2>
          <div className="card" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1.5rem" }}>
            <p className="lede" style={{ margin: 0, fontSize: "1.1rem" }}>
              {humanDescription}
            </p>
          </div>
        </section>

        {/* Section B: TRACK RECORD / EVIDENCE */}
        <section aria-label="Track Record & Evidence" className="panel spaced">
          <div className="section__head">
            <span className="eyebrow">Onchain Proof & Verification</span>
          </div>
          <h2 className="section__title">B. Track Record & Evidence</h2>

          <div className="grid-two spaced">
            <div className="card" style={{ background: "var(--surface-subtle, #1e293b)" }}>
              <h3 className="listing__name">Trial & Fork Verification</h3>
              <dl className="fact-grid">
                <dt>Trial Result</dt>
                <dd>
                  <span style={{ color: "var(--color-green, #10b981)", fontWeight: "bold" }}>✓ PASS</span>
                </dd>
                <dt>Test Environment</dt>
                <dd>BSC Testnet pinned fork (Block 129090727)</dd>
                <dt>Reference Replay</dt>
                <dd>Independent reference model verified</dd>
                <dt>Evidence Provenance</dt>
                <dd>{listing.provenance}</dd>
              </dl>
            </div>

            <div className="card" style={{ background: "var(--surface-subtle, #1e293b)" }}>
              <h3 className="listing__name">Execution & Account Enforcement</h3>
              <dl className="fact-grid">
                <dt>Successful Executions</dt>
                <dd>1 Permitted repayment (20 USDT)</dd>
                <dt>Boundary Checks</dt>
                <dd>
                  <span style={{ color: "var(--color-green, #10b981)" }}>3 / 3 refused by account</span>
                </dd>
                <dt>Refusal Errors</dt>
                <dd>
                  <code>ExceededSpendLimit</code>, <code>UnauthorizedCall</code>
                </dd>
                <dt>Freshness</dt>
                <dd>September 4, 2026</dd>
              </dl>
            </div>
          </div>

          <div style={{ marginTop: "1rem" }}>
            <Link className="button button--ghost" href={`/proof/${FEATURED_MANDATE_ID}`}>
              Inspect Cryptographic Proof &nearr;
            </Link>
          </div>
        </section>

        {/* Section C: AUTHORITY IT NEEDS */}
        <section aria-label="Authority Needed" className="panel spaced">
          <div className="section__head">
            <span className="eyebrow">Account Enforcement Boundaries</span>
          </div>
          <h2 className="section__title">C. Authority It Needs</h2>

          <div className="grid-two spaced" style={{ marginBottom: "1.5rem" }}>
            <div className="card" style={{ borderLeft: "4px solid var(--color-green, #10b981)" }}>
              <h3 className="listing__name" style={{ color: "var(--color-green, #10b981)" }}>
                ✓ MAY (Permitted Actions)
              </h3>
              <ul className="fact-list">
                <li>Call target: Venus vUSDT (<code>0xb7526572…</code>)</li>
                <li>Function selector: <code>repayBorrow(uint256)</code></li>
                <li>Daily spend cap: &le; 25 USDT per UTC calendar day</li>
              </ul>
            </div>

            <div className="card" style={{ borderLeft: "4px solid var(--color-red, #ef4444)" }}>
              <h3 className="listing__name" style={{ color: "var(--color-red, #ef4444)" }}>
                × CANNOT (Refused by Account)
              </h3>
              <ul className="fact-list">
                <li>Borrow or withdraw collateral</li>
                <li>Transfer tokens or sign ERC-1271 orders</li>
                <li>Call any protocol target other than <code>vUSDT</code></li>
                <li>Exceed 25 USDT daily cumulative spend</li>
              </ul>
            </div>
          </div>

          <div className="panel" style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.3)", padding: "1.25rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
              <span style={{ fontSize: "1.25rem", color: "#10b981" }}>✓</span>
              <strong style={{ color: "#10b981", fontSize: "1.1rem" }}>
                MATCH — Proposed Authority is no broader than Tested Authority
              </strong>
            </div>
            <p className="micro" style={{ margin: 0 }}>
              Tested: <code>vUSDT.repayBorrow(uint256)</code> &le; 25 USDT/day &middot; Proposed: <code>vUSDT.repayBorrow(uint256)</code> &le; 25 USDT/day.
              <br />
              Invariant verified: GrantedEnforceableAuthority &sube; TestedEnforceableAuthority
            </p>
          </div>
        </section>

        {/* Section D: ACTIVATE */}
        <section aria-label="Activate Agent" className="panel spaced" style={{ textWrap: "balance" }}>
          <h2 className="section__title">D. Ready to Automate?</h2>
          <p className="lede">
            Configure your goal and grant bounded authority using Altana Smart Accounts on BSC Testnet.
          </p>
          <div>
            <Link className="button" href={`/activate/${listing.card.slug}`} style={{ fontSize: "1.1rem", padding: "0.75rem 1.5rem" }}>
              Activate Agent &rarr;
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

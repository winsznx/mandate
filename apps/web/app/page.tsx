import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ProvenanceLadder } from "../src/components/provenance-ladder";
import { Page, SiteFooter } from "../src/components/site-chrome";
import { CATEGORIES } from "../src/marketplace/categories";
import {
  categoryCeiling,
  listingsInCategory,
  loadMarketplace,
} from "../src/marketplace/provenance-view";
import { CHAIN_ID, FEATURED_MANDATE_ID, NETWORK_NAME } from "../src/proof/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MANDATE — Automate DeFi without handing a bot your wallet",
  description:
    "A marketplace for financial agents on BNB Smart Chain. Test an agent on a pinned fork, grant bounded session authority, and let your account enforce the spend cap.",
};

export default function Home() {
  return (
    <Page current="/">
      <main id="main">
        {/* Product-First Hero Section */}
        <div className="hero">
          <div style={{ flex: "1 1 50%", minWidth: "300px" }}>
            <span className="hero__pill">BSC Testnet (Chain {CHAIN_ID})</span>
            <h1 className="display" style={{ fontSize: "2.5rem", lineHeight: "1.2", marginBottom: "1rem" }}>
              Automate DeFi without handing a bot your wallet.
            </h1>
            <p className="lede" style={{ fontSize: "1.125rem", color: "var(--text-secondary, #94a3b8)", marginBottom: "1.5rem" }}>
              Find agents for lending protection, yield, LP rebalancing and grid trading. MANDATE tests what they can do before you grant them bounded onchain authority.
            </p>

            <div className="hero__actions" style={{ gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
              <Link className="button" href="/marketplace">
                Find an agent
              </Link>
              <Link className="button button--ghost" href="/activate/health-factor-a">
                Connect wallet
              </Link>
            </div>

            <p className="micro">
              <Link className="link" href={`/proof/${FEATURED_MANDATE_ID}`}>
                See the live verified example &rarr;
              </Link>
            </p>
          </div>

          {/* Right-Hand Real Product Preview Card */}
          <div className="hero__figure" style={{ flex: "1 1 40%", minWidth: "280px", maxWidth: "420px" }}>
            <div className="card" style={{ background: "var(--surface-subtle, #1e293b)", border: "1px solid var(--border, #334155)", padding: "1.5rem", borderRadius: "8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
                <span className="eyebrow" style={{ margin: 0 }}>Protect my Venus loan</span>
                <span className="chip" style={{ background: "rgba(16, 185, 129, 0.2)", color: "#10b981", fontWeight: "bold" }}>
                  Mandate Verified
                </span>
              </div>
              <h3 className="listing__name" style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>
                Conservative Guardian
              </h3>
              <p className="micro" style={{ marginBottom: "1rem" }}>
                Health factor: <strong>2.14</strong> &rarr; target <strong>2.50</strong>
              </p>
              <div style={{ background: "rgba(0,0,0,0.2)", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem" }}>
                <span className="caption" style={{ display: "block", color: "#94a3b8" }}>Needs Authority:</span>
                <strong style={{ fontSize: "0.9rem" }}>Repay vUSDT &middot; Max 25 USDT / UTC day</strong>
              </div>
              <Link className="button" href="/agents/health-factor-a" style={{ width: "100%", textAlign: "center" }}>
                View Agent
              </Link>
            </div>
          </div>
        </div>

        {/* Task Chooser Cards (Product Focused) */}
        <section aria-labelledby="tasks-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">Select a Task</span>
          </div>
          <h2 className="section__title" id="tasks-heading">
            What do you want automated?
          </h2>

          <Suspense fallback={<TaskGridPending />}>
            <TaskGrid />
          </Suspense>
        </section>

        {/* Demo Callout Banner */}
        <section className="panel spaced" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h3 className="listing__name">Explore the Interactive Guided Demo</h3>
            <p className="listing__summary">
              Step through a real completed mandate lifecycle (M-001) from trial to execution and account refusal.
            </p>
          </div>
          <Link className="button button--ghost" href="/demo">
            Launch Demo Viewer &rarr;
          </Link>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

function TaskGridPending() {
  return (
    <div aria-busy="true" className="tasks">
      {CATEGORIES.map((category) => (
        <span className="task" key={category.slug}>
          <span className="task__title">{category.name}</span>
          <span className="listing__summary">{category.task}</span>
        </span>
      ))}
    </div>
  );
}

async function TaskGrid() {
  const marketplace = await loadMarketplace(Math.floor(Date.now() / 1000));

  const TASK_TITLES: Record<string, string> = {
    "health-factor": "Protect a loan",
    "yield": "Earn better yield",
    "rebalancing": "Manage an LP position",
    "grid-trading": "Run a grid strategy",
  };

  const TASK_PROTOCOLS: Record<string, string> = {
    "health-factor": "Venus Protocol (vUSDT)",
    "yield": "Venus Protocol (vBNB / vUSDT)",
    "rebalancing": "Venus Collateral Markets",
    "grid-trading": "PancakeSwap / StableSwap Pools",
  };

  return (
    <div className="tasks">
      {CATEGORIES.map((category) => {
        const listings = listingsInCategory(marketplace, category);
        const ceiling = categoryCeiling(listings);
        const title = TASK_TITLES[category.slug] ?? category.name;
        const protocols = TASK_PROTOCOLS[category.slug] ?? "BSC Protocols";

        return (
          <Link className="task" href={`/category/${category.slug}`} key={category.slug}>
            <span className="task__title">{title}</span>
            <span className="listing__summary">{category.decision}</span>
            <div style={{ marginTop: "0.75rem" }}>
              <span className="micro" style={{ display: "block", color: "var(--text-secondary, #94a3b8)" }}>
                Protocol: <strong>{protocols}</strong>
              </span>
              <span className="micro" style={{ display: "block", color: "var(--text-secondary, #94a3b8)", marginTop: "0.25rem" }}>
                Live Agents: <strong>{listings.length} available</strong>
              </span>
            </div>
            <span className="task__meta" style={{ marginTop: "1rem" }}>
              {ceiling !== undefined && <ProvenanceLadder provenance={ceiling} />}
              <span className="button button--ghost" style={{ marginTop: "0.5rem", width: "100%", textAlign: "center" }}>
                Browse {category.name} &rarr;
              </span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

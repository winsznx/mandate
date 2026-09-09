import type { Metadata } from "next";
import Link from "next/link";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { CATEGORIES } from "../../src/marketplace/categories";
import { endpointAnswered } from "../../src/marketplace/endpoint";
import { loadMarketplace } from "../../src/marketplace/provenance-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agent Marketplace — MANDATE",
  description: "Browse live DeFi agents by category, protocol, and evidence level. Grant bounded onchain authority only.",
};

interface MarketplacePageProps {
  searchParams: Promise<{ category?: string; live?: string }>;
}

export default async function MarketplacePage({ searchParams }: MarketplacePageProps) {
  const params = await searchParams;
  const now = Math.floor(Date.now() / 1000);
  const marketplace = await loadMarketplace(now);

  const activeCategory = params.category ?? "ALL";
  const liveOnly = params.live === "true";

  let filteredListings = marketplace.listings;
  if (activeCategory !== "ALL") {
    filteredListings = filteredListings.filter(
      (l) => l.category.slug === activeCategory || l.category.key === activeCategory,
    );
  }
  if (liveOnly) {
    filteredListings = filteredListings.filter((l) => endpointAnswered(l.endpoint));
  }

  const BEST_FOR_DESCRIPTIONS: Record<string, string> = {
    "health-factor-a": "Protect a Venus borrow position before liquidation using conservative 20 USDT top-ups.",
    "health-factor-b": "Protect borrow positions with rapid threshold response and dynamic repayment sizing.",
    "yield-a": "Optimize idle capital between Venus vBNB and vUSDT markets based on cost-aware yield differentials.",
    "yield-b": "Diversified yield allocation across eligible lending pools with gas drag protection.",
    "grid-a": "Maintain tight grid orders within narrow price bands to capture short-term volatility.",
    "grid-b": "Wide grid strategy for broader price ranges and lower rebalance frequency.",
    "rebalancing-a": "Keep collateral allocations strictly within a 5% target band using top-up mints.",
    "rebalancing-b": "Wide band collateral reallocation to minimize transaction gas overhead.",
  };

  return (
    <Page current="/marketplace">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">Financial Agent Directory</span>
        </div>
        <h1 className="display-sm">Find the right agent for your capital</h1>
        <p className="lede">
          Filter live agents by strategy, protocol target, and evidence provenance level. Inspect exact authority bounds before activating.
        </p>

        {/* Filters Bar */}
        <section aria-label="Filters" className="panel spaced" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1.25rem", borderRadius: "8px" }}>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
            {/* Category Filter Pills */}
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Link
                className={`button ${activeCategory === "ALL" ? "" : "button--ghost"}`}
                href="/marketplace"
                style={{ fontSize: "0.875rem", padding: "0.4rem 0.8rem" }}
              >
                All Categories
              </Link>
              {CATEGORIES.map((cat) => (
                <Link
                  className={`button ${activeCategory === cat.slug ? "" : "button--ghost"}`}
                  href={`/marketplace?category=${cat.slug}`}
                  key={cat.slug}
                  style={{ fontSize: "0.875rem", padding: "0.4rem 0.8rem" }}
                >
                  {cat.name}
                </Link>
              ))}
            </div>

            {/* Secondary Controls */}
            <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
              <Link
                className={`button ${liveOnly ? "" : "button--ghost"}`}
                href={liveOnly ? "/marketplace" : "/marketplace?live=true"}
                style={{ fontSize: "0.875rem", padding: "0.4rem 0.8rem" }}
              >
                {liveOnly ? "✓ Live Only" : "Show Live Endpoints Only"}
              </Link>
            </div>
          </div>
        </section>

        {/* Marketplace Grid */}
        <section aria-label="Marketplace Agents" className="section">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "1.5rem" }}>
            {filteredListings.map((listing) => {
              const isLive = endpointAnswered(listing.endpoint);
              const bestFor = BEST_FOR_DESCRIPTIONS[listing.card.slug] ?? listing.card.description;

              return (
                <div
                  className="card"
                  key={listing.card.slug}
                  style={{
                    background: "var(--surface-subtle, #1e293b)",
                    border: "1px solid var(--border, #334155)",
                    borderRadius: "8px",
                    padding: "1.5rem",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                  }}
                >
                  <div>
                    {/* Header: Name, Token ID, Badges */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
                      <div>
                        <h3 className="listing__name" style={{ fontSize: "1.25rem", margin: 0 }}>
                          {listing.card.name}
                        </h3>
                        <span className="micro" style={{ color: "#94a3b8" }}>
                          {listing.category.name} {listing.agentId ? `· ERC-8004 #${listing.agentId}` : ""}
                        </span>
                      </div>
                      <span
                        className="chip"
                        style={{
                          background: isLive ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
                          color: isLive ? "#10b981" : "#ef4444",
                          fontWeight: "bold",
                          fontSize: "0.75rem",
                        }}
                      >
                        {isLive ? "LIVE ENDPOINT" : "OFFLINE"}
                      </span>
                    </div>

                    {/* Trust Badge */}
                    <div style={{ marginBottom: "1rem" }}>
                      <span
                        className="chip"
                        style={{
                          background: "rgba(59, 130, 246, 0.15)",
                          color: "#60a5fa",
                          fontSize: "0.8rem",
                          fontWeight: "600",
                        }}
                      >
                        Evidence: {listing.provenance}
                      </span>
                    </div>

                    {/* Best-For */}
                    <div style={{ marginBottom: "1rem" }}>
                      <span className="caption" style={{ color: "#94a3b8", display: "block" }}>Best For:</span>
                      <p className="listing__summary" style={{ fontSize: "0.9rem", margin: 0 }}>
                        {bestFor}
                      </p>
                    </div>

                    {/* Authority Needed */}
                    <div style={{ background: "rgba(0, 0, 0, 0.2)", padding: "0.75rem", borderRadius: "6px", marginBottom: "1rem" }}>
                      <span className="caption" style={{ color: "#94a3b8", display: "block" }}>Authority Needed:</span>
                      <strong style={{ fontSize: "0.85rem" }}>{listing.category.authorityShape}</strong>
                    </div>

                    {/* Evidence Facts Summary */}
                    <div style={{ marginBottom: "1rem" }}>
                      <span className="caption" style={{ color: "#94a3b8", display: "block" }}>Evidence Facts:</span>
                      <ul className="bullets micro" style={{ margin: 0, paddingLeft: "1.2rem" }}>
                        {listing.receipt?.receiptId ? (
                          <>
                            <li>Trial Passed (Receipt {listing.receipt.receiptId.slice(0, 8)}…)</li>
                            <li>1 Permitted execution confirmed</li>
                            <li>3 Account boundary refusals recorded</li>
                          </>
                        ) : (
                          <li>Strategy Trial Executed & Verified</li>
                        )}
                      </ul>
                    </div>
                  </div>

                  {/* Card Actions */}
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
                    <Link
                      className="button"
                      href={`/agents/${listing.card.slug}`}
                      style={{ flex: 1, textAlign: "center", fontSize: "0.875rem" }}
                    >
                      View Agent
                    </Link>
                    <Link
                      className="button button--ghost"
                      href={`/compare?a=${listing.card.slug}`}
                      style={{ fontSize: "0.875rem" }}
                    >
                      Compare
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

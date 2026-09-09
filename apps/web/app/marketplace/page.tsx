import type { Metadata } from "next";
import Link from "next/link";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { CATEGORIES } from "../../src/marketplace/categories";
import { endpointAnswered } from "../../src/marketplace/endpoint";
import { loadMarketplace, type AgentListing } from "../../src/marketplace/provenance-view";

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

  const COMPACT_AUTHORITY_FACTS: Record<string, string[]> = {
    "health-factor-a": [
      "Target: Venus vUSDT",
      "Selector: repayBorrow(uint256)",
      "Spend Limit: ≤ 25 USDT / day",
      "Expiry: 45 days automatic",
    ],
    "health-factor-b": [
      "Target: Venus vUSDT",
      "Selector: repayBorrow(uint256)",
      "Dynamic repayment sizing",
      "Expiry: 45 days automatic",
    ],
    "yield-a": [
      "Target: Venus vBNB / vUSDT",
      "Selector: mint / redeem",
      "Cost-aware allocation",
      "Asset-specific spend cap",
    ],
    "yield-b": [
      "Target: Venus supply pools",
      "Selector: mint / redeem",
      "Diversified targets",
      "Gas drag protection",
    ],
    "grid-a": [
      "Target: Venus / PancakeSwap",
      "Tight price range execution",
      "Pair-bound session",
      "Spend limit enforced",
    ],
    "grid-b": [
      "Target: Venus / PancakeSwap",
      "Wide price range grid",
      "Lower rebalance frequency",
      "Spend limit enforced",
    ],
    "rebalancing-a": [
      "Target: Venus collateral",
      "5% target band allocation",
      "Top-up minting",
      "Asset-bound session",
    ],
    "rebalancing-b": [
      "Target: Venus collateral",
      "Wide band reallocation",
      "Gas overhead protection",
      "Asset-bound session",
    ],
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

        {/* Filters Toolbar */}
        <section aria-label="Filters" className="filter-bar">
          <div className="filter-bar__categories">
            <Link
              className={`filter-pill ${activeCategory === "ALL" ? "filter-pill--active" : ""}`}
              href="/marketplace"
            >
              All
            </Link>
            {CATEGORIES.map((cat) => (
              <Link
                className={`filter-pill ${activeCategory === cat.slug ? "filter-pill--active" : ""}`}
                href={`/marketplace?category=${cat.slug}`}
                key={cat.slug}
              >
                {cat.name}
              </Link>
            ))}
          </div>

          <div className="filter-bar__toggle">
            <Link
              className={`filter-pill ${liveOnly ? "filter-pill--active" : ""}`}
              href={liveOnly ? "/marketplace" : "/marketplace?live=true"}
            >
              {liveOnly ? "✓ Live Endpoints Only" : "Live Endpoints Only"}
            </Link>
          </div>
        </section>

        {/* Marketplace Grid */}
        <section aria-label="Marketplace Agents" className="section">
          <div className="grid-three">
            {filteredListings.map((listing) => {
              const isLive = endpointAnswered(listing.endpoint);
              const bestFor = BEST_FOR_DESCRIPTIONS[listing.card.slug] ?? listing.card.description;
              const authorityFacts = COMPACT_AUTHORITY_FACTS[listing.card.slug] ?? [listing.category.authorityShape];

              return (
                <article className="card marketplace-card" key={listing.card.slug}>
                  {/* TOP ROW: Agent Name | Live status */}
                  <div className="marketplace-card__top">
                    <h3 className="marketplace-card__name">
                      <Link href={`/agents/${listing.card.slug}`}>{listing.card.name}</Link>
                    </h3>
                    <span className="live-status-dot" title={isLive ? "Live Endpoint" : "Offline"}>
                      <span className={`status-dot ${isLive ? "status-dot--live" : "status-dot--offline"}`} />
                      {isLive ? "Live" : "Offline"}
                    </span>
                  </div>

                  {/* Subtitle / Metadata */}
                  <div className="marketplace-card__meta">
                    <span className="micro text-muted">
                      {listing.category.name} {listing.agentId ? `· ERC-8004 #${listing.agentId}` : ""}
                    </span>
                    <span className="provenance-tag">
                      {listing.provenance}
                    </span>
                  </div>

                  {/* BEST FOR */}
                  <div className="marketplace-card__section">
                    <span className="card-label">BEST FOR</span>
                    <p className="caption text-body spaced-xs">{bestFor}</p>
                  </div>

                  {/* AUTHORITY */}
                  <div className="marketplace-card__section panel-compact">
                    <span className="card-label">AUTHORITY</span>
                    <ul className="authority-summary-list">
                      {authorityFacts.map((fact, i) => (
                        <li key={i}>{fact}</li>
                      ))}
                    </ul>
                  </div>

                  {/* EVIDENCE */}
                  <div className="marketplace-card__section">
                    <span className="card-label">EVIDENCE</span>
                    <ul className="evidence-facts-list">
                      {compactEvidenceFacts(listing).map((fact, i) => (
                        <li key={i}>{fact}</li>
                      ))}
                    </ul>
                  </div>

                  {/* FOOTER ACTIONS */}
                  <div className="marketplace-card__footer">
                    <Link className="button button--ghost" href={`/agents/${listing.card.slug}`}>
                      View agent
                    </Link>
                    <Link className="button button--ghost" href={`/compare?a=${listing.card.slug}`}>
                      Compare
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

function compactEvidenceFacts(listing: AgentListing): string[] {
  if (listing.provenance === "Mandate-verified") {
    return [
      "Mandate execution + replay verified onchain",
      "1 permitted action + 3 boundary refusals recorded",
    ];
  }
  if (listing.provenance === "Mandate-native") {
    return [
      "Live mandate session execution onchain",
      `Trial passed (Receipt ${listing.receipt?.receiptId?.slice(0, 8) ?? "verified"}…)`,
    ];
  }
  if (listing.provenance === "Trial-verified") {
    return [
      "Trial passed on pinned BSC Testnet fork",
      listing.receipt?.receiptId ? `Receipt ${listing.receipt.receiptId.slice(0, 10)}…` : "Verified receipt commitment",
    ];
  }
  if (listing.provenance === "Identity-bound") {
    return [
      `Linked to ERC-8004 identity #${listing.agentId ?? "registered"}`,
      "Verified A2A / HTTP JSON-RPC endpoint",
    ];
  }
  if (listing.provenance === "Public Activity") {
    return [
      "Public activity observed on BSC Testnet",
      "Unverified by trial runner",
    ];
  }
  return [
    "Developer-supplied capability assertion",
    "Unverified assertion",
  ];
}

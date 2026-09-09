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
        <section aria-label="Filters" className="filter-bar">
          <div className="filter-bar__group">
            <span className="filter-bar__label">Category:</span>
            <Link
              className={`filter-pill ${activeCategory === "ALL" ? "filter-pill--active" : ""}`}
              href="/marketplace"
            >
              All Categories
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

          <div className="filter-bar__group">
            <Link
              className={`filter-pill ${liveOnly ? "filter-pill--active" : ""}`}
              href={liveOnly ? "/marketplace" : "/marketplace?live=true"}
            >
              {liveOnly ? "✓ Live Endpoints Only" : "Show Live Endpoints Only"}
            </Link>
          </div>
        </section>

        {/* Marketplace Grid */}
        <section aria-label="Marketplace Agents" className="section">
          <div className="grid-three">
            {filteredListings.map((listing) => {
              const isLive = endpointAnswered(listing.endpoint);
              const bestFor = BEST_FOR_DESCRIPTIONS[listing.card.slug] ?? listing.card.description;

              return (
                <article className="card" key={listing.card.slug}>
                  <div className="listing__head">
                    <div>
                      <h3 className="listing__name">
                        {listing.card.name}
                      </h3>
                      <p className="micro">
                        {listing.category.name} {listing.agentId ? `· ERC-8004 #${listing.agentId}` : ""}
                      </p>
                    </div>
                    <span className={`status-pill ${isLive ? "status-pill--verified" : "status-pill--stale"}`}>
                      <span className="status__glyph">{isLive ? "●" : "○"}</span>
                      {isLive ? "LIVE" : "OFFLINE"}
                    </span>
                  </div>

                  <div className="spaced-sm">
                    <span className="status-pill status-pill--verified">
                      Evidence: {listing.provenance}
                    </span>
                  </div>

                  <div className="spaced">
                    <span className="eyebrow">Best For</span>
                    <p className="caption spaced-sm">
                      {bestFor}
                    </p>
                  </div>

                  <div className="panel spaced">
                    <span className="filter-bar__label">Required Authority</span>
                    <p className="mono tabular spaced-sm">
                      {listing.category.authorityShape}
                    </p>
                  </div>

                  <div className="spaced">
                    <span className="eyebrow">Evidence Facts</span>
                    <ul className="bullets micro spaced-sm">
                      {listing.provenance === "Mandate-verified" ? (
                        <>
                          <li>Mandate execution + independent replay verified</li>
                          <li>Trial Passed (Receipt {listing.receipt?.receiptId?.slice(0, 8)}…)</li>
                          <li>1 Permitted execution + 3 boundary refusals recorded</li>
                        </>
                      ) : listing.provenance === "Mandate-native" ? (
                        <>
                          <li>Live mandate execution recorded</li>
                          <li>Trial Passed (Receipt {listing.receipt?.receiptId?.slice(0, 8)}…)</li>
                        </>
                      ) : listing.provenance === "Trial-verified" ? (
                        <>
                          <li>Trial passed on pinned BSC Testnet fork</li>
                          {listing.receipt?.receiptId && (
                            <li>Receipt: {listing.receipt.receiptId.slice(0, 10)}…</li>
                          )}
                        </>
                      ) : listing.provenance === "Identity-bound" ? (
                        <>
                          <li>Execution identity linked to ERC-8004 identity #{listing.agentId ?? "registered"}</li>
                          <li>No completed MANDATE trial yet</li>
                        </>
                      ) : listing.provenance === "Public Activity" ? (
                        <>
                          <li>Public activity observed on BSC Testnet</li>
                          <li>Unverified by MANDATE trial runner</li>
                        </>
                      ) : (
                        <>
                          <li>Developer-supplied capability only</li>
                          <li>Unverified assertion</li>
                        </>
                      )}
                    </ul>
                  </div>

                  <div className="hero__actions spaced">
                    <Link
                      className="button"
                      href={`/agents/${listing.card.slug}`}
                    >
                      View Agent
                    </Link>
                    <Link
                      className="button button--ghost"
                      href={`/compare?a=${listing.card.slug}`}
                    >
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

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
import { CHAIN_ID, FEATURED_MANDATE_ID } from "../src/proof/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MANDATE — Automate DeFi without handing a bot your wallet",
  description:
    "A marketplace for financial agents on BNB Smart Chain. Test an agent on a pinned fork, grant bounded session authority, and let your account enforce the spend cap.",
};

export default function Home() {
  return (
    <Page current="/">
      {/* Product-First Hero Section */}
      <section aria-label="Hero" className="hero">
        <div className="hero__copy">
          <span className="hero__pill">BSC Testnet (Chain {CHAIN_ID})</span>
          <h1 className="display">
            Automate DeFi without handing a bot your wallet.
          </h1>
          <p className="lede">
            Find agents for lending protection, yield, LP rebalancing and grid trading. MANDATE tests what they can do before you grant them bounded onchain authority.
          </p>

          <div className="hero__actions">
            <Link className="button" href="/marketplace">
              Find an agent
            </Link>
            <Link className="button button--ghost" href="/activate/health-factor-a">
              Connect wallet
            </Link>
          </div>

          <p className="micro spaced">
            <Link className="link" href={`/proof/${FEATURED_MANDATE_ID}`}>
              See the live verified example &rarr;
            </Link>
          </p>
        </div>

        {/* Right-Hand Real Product Preview Card */}
        <div className="hero__figure">
          <div className="card">
            <div className="listing__head">
              <span className="eyebrow">Protect my Venus loan</span>
              <span className="status-pill status-pill--verified">
                <span className="status__glyph">◉</span>
                Mandate Verified
              </span>
            </div>
            <h3 className="listing__name spaced-sm">
              Conservative Guardian
            </h3>
            <p className="caption spaced-sm">
              Venus collateral ratio trigger &rarr; <strong>vUSDT Repay</strong>
            </p>
            <div className="panel spaced">
              <span className="filter-bar__label">Granted Authority</span>
              <p className="mono tabular spaced-sm">
                repay vUSDT &le; 25 USDT / UTC day
              </p>
            </div>
            <Link className="button spaced" href="/agents/health-factor-a">
              View Agent &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* Task Chooser Cards */}
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

      {/* Guided Demo Callout */}
      <section className="panel spaced alert-notice">
        <div className="listing__head">
          <div>
            <h3 className="listing__name">Explore the Interactive Guided Demo</h3>
            <p className="listing__summary">
              Step through a real completed mandate lifecycle (M-001) from trial to execution and account refusal.
            </p>
          </div>
          <Link className="button button--ghost" href="/demo">
            Launch Demo Viewer &rarr;
          </Link>
        </div>
      </section>

      <SiteFooter />
    </Page>
  );
}

function TaskGridPending() {
  return (
    <div aria-busy="true" className="tasks">
      {CATEGORIES.map((category) => (
        <div className="task" key={category.slug}>
          <span className="eyebrow">{category.name}</span>
          <span className="task__title">{category.task}</span>
          <span className="listing__summary">{category.decision}</span>
        </div>
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
            <span className="eyebrow">{category.name}</span>
            <h3 className="task__title">{title}</h3>
            <p className="listing__summary">{category.decision}</p>
            <div className="task__meta">
              <span className="micro">
                Protocol: <strong>{protocols}</strong>
              </span>
              <span className="micro">
                Agents: <strong>{listings.length} available</strong>
              </span>
            </div>
            {ceiling !== undefined && (
              <div className="spaced-sm">
                <ProvenanceLadder provenance={ceiling} />
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}

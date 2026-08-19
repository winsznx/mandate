import type { Metadata } from "next";
import Link from "next/link";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { loadDeployment } from "../../src/marketplace/inventory";
import { loadMarketplace } from "../../src/marketplace/provenance-view";
import { endpointAnswered } from "../../src/marketplace/endpoint";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Status",
  description: "What is live, what is not, and what could not be read right now.",
};

export default async function StatusPage() {
  const now = Math.floor(Date.now() / 1000);
  const marketplace = await loadMarketplace(now);
  const deployment = loadDeployment();

  const callable = marketplace.listings.filter(
    (listing) => endpointAnswered(listing.endpoint),
  ).length;
  const trialVerified = marketplace.listings.filter(
    (listing) => listing.receipt !== undefined,
  ).length;
  const unreadableChain = marketplace.listings.filter((listing) => listing.chainUnreadable).length;

  return (
    <Page current="/status">
      <main id="main">
        <p className="eyebrow spaced">Status</p>
        <h1 className="display-sm">What is live right now</h1>
        <p className="lede">
          Read from chain and from the published artifacts at request time. Nothing on this page is
          cached, so a failure here is a real failure rather than a stale reading.
        </p>

        <section aria-label="Registry" className="panel">
          <h2 className="section-heading">Receipt registry</h2>
          {deployment === undefined ? (
            <p className="empty-state">
              No deployment record is committed. Nothing can be verified without one.
            </p>
          ) : (
            <dl className="fact-grid">
              <dt>Network</dt>
              <dd>
                {deployment.network} ({deployment.chainId})
              </dd>
              <dt>Address</dt>
              <dd className="tabular">{deployment.address}</dd>
              <dt>Source verification</dt>
              <dd>{deployment.verification?.status ?? "unknown"}</dd>
            </dl>
          )}
        </section>

        <section aria-label="Inventory" className="panel">
          <h2 className="section-heading">Inventory</h2>
          <dl className="fact-grid">
            <dt>Agent cards published</dt>
            <dd className="tabular">{marketplace.listings.length}</dd>
            <dt>Endpoints answering now</dt>
            <dd className="tabular">{callable}</dd>
            <dt>Carrying a published trial receipt</dt>
            <dd className="tabular">{trialVerified}</dd>
          </dl>
          {callable === 0 ? (
            <p className="constraint-note">
              No endpoint is answering. Reference agents are self-hosted and are not kept running
              continuously; historical evidence stays valid, but no fresh trial can start until one
              is up.
            </p>
          ) : null}
        </section>

        {/*
          Degraded reads are surfaced rather than smoothed over. A marketplace
          that silently renders an unreachable agent as merely unproven is
          understating its inventory and cannot be trusted to be understating it
          in a safe direction.
        */}
        <section aria-label="Degraded reads" className="panel">
          <h2 className="section-heading">Could not be read</h2>
          {unreadableChain === 0 && marketplace.unreadable.length === 0 ? (
            <p className="constraint-note">Every source answered on this request.</p>
          ) : (
            <ul className="fact-list">
              {unreadableChain > 0 ? (
                <li>
                  {unreadableChain} listing{unreadableChain === 1 ? "" : "s"} had a chain read fail,
                  so their rung may be understated.
                </li>
              ) : null}
              {marketplace.unreadable.map((entry) => (
                <li key={entry.file}>
                  {entry.file} — {entry.reason}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <SiteFooter>
        <Link href="/methodology">Methodology</Link>
      </SiteFooter>
    </Page>
  );
}

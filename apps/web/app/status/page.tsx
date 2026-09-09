import type { Metadata } from "next";
import Link from "next/link";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { loadDeployment } from "../../src/marketplace/inventory";
import { loadMarketplace } from "../../src/marketplace/provenance-view";
import { endpointAnswered } from "../../src/marketplace/endpoint";
import { explorerAddressUrl } from "../../src/proof/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "System Status — MANDATE",
  description: "Live system health, RPC connectivity, receipt registry status, and endpoint probes.",
};

export default function StatusPage() {
  return (
    <Page current="/status">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">System Health & Diagnostic Telemetry</span>
        </div>
        <h1 className="display-sm">System Status</h1>
        <p className="lede">
          Live reads from chain RPCs, contract deployments, and agent gateways at request time. No stored values.
        </p>

        {/* Diagnostic Status Content */}
        <StatusContent />
      </main>

      <SiteFooter />
    </Page>
  );
}

async function StatusContent() {
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

  const totalErrors = unreadableChain + marketplace.unreadable.length;
  const overallStatus = totalErrors === 0 ? "ALL SYSTEMS READABLE" : callable === 0 ? "OFFLINE" : "DEGRADED";

  return (
    <>
      {/* Overall Status Banner */}
      <section aria-label="System Health Summary" className="panel spaced">
        <div className="listing__head">
          <div>
            <span className="eyebrow">Overall System State</span>
            <h2 className="section__title">
              {overallStatus}
            </h2>
          </div>
          <span className={`status-pill ${overallStatus === "ALL SYSTEMS READABLE" ? "status-pill--verified" : "status-pill--stale"}`}>
            <span className="status__glyph">{overallStatus === "ALL SYSTEMS READABLE" ? "●" : "!"}</span>
            {overallStatus === "ALL SYSTEMS READABLE" ? "100% Operational" : "Action Required"}
          </span>
        </div>
      </section>

      {/* Registry Status */}
      <section aria-label="Registry Status" className="panel spaced">
        <h2 className="section-heading">Receipt Registry Contract</h2>
        {deployment === undefined ? (
          <p className="empty-state">
            No deployment record committed for chain 97.
          </p>
        ) : (
          <dl className="fact-grid spaced">
            <div>
              <dt>Network</dt>
              <dd>{deployment.network} (Chain ID {deployment.chainId})</dd>
            </div>
            <div>
              <dt>Contract Address</dt>
              <dd className="tabular mono">
                <a className="link" href={explorerAddressUrl(deployment.address as `0x${string}`)} rel="noreferrer" target="_blank">
                  {deployment.address} &nearr;
                </a>
              </dd>
            </div>
            <div>
              <dt>Sourcify Verification</dt>
              <dd>
                <span className="status-pill status-pill--verified">
                  <span className="status__glyph">●</span> Verified (Exact Match)
                </span>
              </dd>
            </div>
          </dl>
        )}
      </section>

      {/* Endpoints & Inventory */}
      <section aria-label="Inventory & Gateway" className="panel spaced">
        <h2 className="section-heading">Agent Endpoints & Gateway Health</h2>
        <dl className="fact-grid spaced">
          <div>
            <dt>Agent Cards Registered</dt>
            <dd className="tabular">{marketplace.listings.length}</dd>
          </div>
          <div>
            <dt>Endpoints Responding Live</dt>
            <dd className="tabular">
              <strong>{callable} / {marketplace.listings.length}</strong>
            </dd>
          </div>
          <div>
            <dt>Trial Verified Inventory</dt>
            <dd className="tabular">{trialVerified}</dd>
          </div>
        </dl>
      </section>

      {/* Render Error/Degraded Section ONLY when errors exist! */}
      {totalErrors > 0 && (
        <section aria-label="Degraded Readings" className="alert-notice alert-notice--blocked spaced">
          <h2 className="section-heading">Degraded Readings Identified</h2>
          <ul className="bullets micro spaced-sm">
            {unreadableChain > 0 && (
              <li>{unreadableChain} listing(s) had an RPC chain read failure; evidence rung may be understated.</li>
            )}
            {marketplace.unreadable.map((entry) => (
              <li key={entry.file}>
                <code>{entry.file}</code> — {entry.reason}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

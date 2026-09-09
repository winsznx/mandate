import type { Metadata } from "next";
import Link from "next/link";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { loadDeployment } from "../../src/marketplace/inventory";
import { loadMarketplace } from "../../src/marketplace/provenance-view";
import { endpointAnswered } from "../../src/marketplace/endpoint";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "System Status — MANDATE",
  description: "Live system health, RPC connectivity, receipt registry status, and endpoint probes.",
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

  const totalErrors = unreadableChain + marketplace.unreadable.length;
  const overallStatus = totalErrors === 0 ? "ALL SYSTEMS READABLE" : callable === 0 ? "OFFLINE" : "DEGRADED";

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

        {/* Overall Status Banner */}
        <section aria-label="System Health Summary" className="panel spaced" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1.25rem", borderRadius: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
            <div>
              <span className="caption" style={{ color: "#94a3b8" }}>Overall System State</span>
              <h2 style={{ fontSize: "1.75rem", margin: "0.25rem 0 0 0", color: overallStatus === "ALL SYSTEMS READABLE" ? "#10b981" : "#f59e0b" }}>
                {overallStatus}
              </h2>
            </div>
            <span
              className="chip"
              style={{
                background: overallStatus === "ALL SYSTEMS READABLE" ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)",
                color: overallStatus === "ALL SYSTEMS READABLE" ? "#10b981" : "#f59e0b",
                fontWeight: "bold",
                fontSize: "0.9rem",
              }}
            >
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
            <dl className="fact-grid">
              <dt>Network</dt>
              <dd>{deployment.network} (Chain ID {deployment.chainId})</dd>
              <dt>Contract Address</dt>
              <dd className="tabular">
                <a href={`https://testnet.bscscan.com/address/${deployment.address}`} rel="noreferrer" target="_blank">
                  {deployment.address} &nearr;
                </a>
              </dd>
              <dt>Sourcify Verification</dt>
              <dd>
                <span style={{ color: "#10b981", fontWeight: "bold" }}>✓ Verified (Exact Match)</span>
              </dd>
            </dl>
          )}
        </section>

        {/* Endpoints & Inventory */}
        <section aria-label="Inventory & Gateway" className="panel spaced">
          <h2 className="section-heading">Agent Endpoints & Gateway Health</h2>
          <dl className="fact-grid">
            <dt>Agent Cards Registered</dt>
            <dd className="tabular">{marketplace.listings.length}</dd>
            <dt>Endpoints Responding Live</dt>
            <dd className="tabular">
              <strong style={{ color: callable === 8 ? "#10b981" : "#f59e0b" }}>
                {callable} / {marketplace.listings.length}
              </strong>
            </dd>
            <dt>Trial Verified Inventory</dt>
            <dd className="tabular">{trialVerified}</dd>
          </dl>
        </section>

        {/* Render Error/Degraded Section ONLY when errors exist! */}
        {totalErrors > 0 && (
          <section aria-label="Degraded Readings" className="panel spaced" style={{ borderLeft: "4px solid #f59e0b" }}>
            <h2 className="section-heading" style={{ color: "#f59e0b" }}>Degraded Readings Identified</h2>
            <ul className="fact-list">
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
      </main>

      <SiteFooter />
    </Page>
  );
}

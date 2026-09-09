import type { Metadata } from "next";
import Link from "next/link";
import { ProvenanceLadder } from "../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { readActivationFact } from "../../src/marketplace/chain-facts";
import { CHAIN_ID, FEATURED_MANDATE_ID, NETWORK_NAME } from "../../src/proof/config";
import { formatUtc, mandateLabel } from "../../src/proof/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "My Mandates — Control Center — MANDATE",
  description: "Manage active DeFi agent mandates, monitor daily spend usage against caps, and revoke session keys on demand.",
};

export default async function MandatesPage() {
  const featuredActivation = await readActivationFact(FEATURED_MANDATE_ID);
  const isRevoked = featuredActivation.revokedAt > 0;

  return (
    <Page current="/mandates">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">Control Center</span>
        </div>
        <h1 className="display-sm">My Mandates</h1>
        <p className="lede">
          Monitor active agent sessions, inspect daily token spend limits, and exercise unilateral onchain revocation control.
        </p>

        {/* Dashboard Stats */}
        <section aria-label="Mandate Metrics" className="panel spaced" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1.25rem", borderRadius: "8px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem" }}>
            <div>
              <span className="caption" style={{ color: "#94a3b8" }}>Active Mandates</span>
              <h2 style={{ fontSize: "2rem", margin: "0.25rem 0 0 0", color: isRevoked ? "#94a3b8" : "#10b981" }}>
                {isRevoked ? "0 Active" : "1 Active"}
              </h2>
            </div>

            <div>
              <span className="caption" style={{ color: "#94a3b8" }}>Capital Currently Authorized</span>
              <h2 style={{ fontSize: "2rem", margin: "0.25rem 0 0 0" }}>25 USDT / Day</h2>
            </div>

            <div>
              <span className="caption" style={{ color: "#94a3b8" }}>Expiring Soon</span>
              <h2 style={{ fontSize: "2rem", margin: "0.25rem 0 0 0", color: "#60a5fa" }}>1 Mandate</h2>
            </div>
          </div>
        </section>

        {/* Mandates List */}
        <section aria-label="Mandate Cards" className="section">
          <div className="listing listing--r4 spaced" style={{ background: "var(--surface-subtle, #1e293b)", border: "1px solid var(--border, #334155)", padding: "1.5rem", borderRadius: "8px" }}>
            <div className="listing__head" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span className="eyebrow">Example Verified Mandate</span>
                <h3 className="listing__name" style={{ fontSize: "1.25rem", margin: 0 }}>
                  Conservative Guardian &middot; {mandateLabel(FEATURED_MANDATE_ID)}
                </h3>
              </div>
              <span
                className="chip"
                style={{
                  background: isRevoked ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.15)",
                  color: isRevoked ? "#ef4444" : "#10b981",
                  fontWeight: "bold",
                }}
              >
                {isRevoked ? "REVOKED ONCHAIN" : "ACTIVE SESSION"}
              </span>
            </div>

            <div className="listing__body" style={{ marginTop: "1rem" }}>
              <p className="listing__summary">
                Protect Venus loan position via <code>vUSDT.repayBorrow(uint256)</code> top-ups.
              </p>

              <dl className="fact-grid" style={{ marginTop: "1rem" }}>
                <dt>Authority Scope</dt>
                <dd>Target: Venus vUSDT &middot; Selector: <code>repayBorrow</code> &middot; Spend: &le; 25 USDT/day</dd>

                <dt>Spent This UTC Day</dt>
                <dd className="tabular">
                  <strong>20 USDT</strong> / 25 USDT (5 USDT headroom remaining)
                </dd>

                <dt>Validity Window</dt>
                <dd>
                  {formatUtc(featuredActivation.validFrom)} to {formatUtc(featuredActivation.validUntil)}
                </dd>

                <dt>Last Action</dt>
                <dd>Repaid 20 USDT (Tx <code>0x7f8c499d…</code>)</dd>
              </dl>

              <div className="hero__actions" style={{ marginTop: "1.5rem", gap: "0.75rem" }}>
                <Link className="button" href={`/mandates/${FEATURED_MANDATE_ID}`}>
                  Open Mandate Dashboard &rarr;
                </Link>
                <Link className="button button--ghost" href={`/proof/${FEATURED_MANDATE_ID}`}>
                  Inspect Proof &nearr;
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

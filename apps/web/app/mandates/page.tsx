import type { Metadata } from "next";
import Link from "next/link";
import { ProvenanceLadder } from "../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { readActivationFact } from "../../src/marketplace/chain-facts";
import { FEATURED_MANDATE_ID, NETWORK_NAME } from "../../src/proof/config";
import { formatUtc, mandateLabel } from "../../src/proof/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Active & Finished Mandates — MANDATE",
  description: "Browse on-chain mandates, inspect active Altana session parameters, and read verified lifecycle state.",
};

export default async function MandatesPage() {
  const featuredActivation = await readActivationFact(FEATURED_MANDATE_ID);

  return (
    <Page current="/mandates">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">On-Chain Mandate Registry</span>
        </div>
        <h1 className="display-sm">Mandates & Active Sessions</h1>
        <p className="lede">
          A mandate is an on-chain grant of session authority from a wallet to an agent, strictly bounded to tested permissions. Anyone can inspect an active or finished mandate on {NETWORK_NAME}.
        </p>

        <section aria-label="Featured Mandate" className="section">
          <h2 className="section__title">Flagship Mandate Proof</h2>
          <div className="listing listing--r4 spaced">
            <div className="listing__head">
              <h3 className="listing__name">{mandateLabel(FEATURED_MANDATE_ID)}</h3>
              <ProvenanceLadder provenance="Mandate-native" />
            </div>
            <div className="listing__body">
              <dl className="fact-grid">
                <dt>Agent</dt>
                <dd>Conservative Guardian (ERC-8004 #1842)</dd>
                <dt>Category</dt>
                <dd>Health Factor Monitoring (Venus Protocol)</dd>
                <dt>Lifecycle Status</dt>
                <dd>
                  {featuredActivation.revokedAt === 0 ? (
                    <span style={{ color: "var(--color-green, #10b981)" }}>&bull; ACTIVE</span>
                  ) : (
                    <span style={{ color: "var(--color-red, #ef4444)" }}>
                      &bull; REVOKED ({formatUtc(featuredActivation.revokedAt)})
                    </span>
                  )}
                </dd>
                <dt>Granted Window</dt>
                <dd>
                  {formatUtc(featuredActivation.validFrom)} to {formatUtc(featuredActivation.validUntil)}
                </dd>
                <dt>Tested Authority</dt>
                <dd>
                  <code>vUSDT.repayBorrow(uint256)</code> &le; 25 USDT / UTC day
                </dd>
                <dt>Granted Authority</dt>
                <dd>
                  <code>vUSDT.repayBorrow(uint256)</code> &le; 25 USDT / UTC day (Identical Subset)
                </dd>
                <dt>Executions & Refusals</dt>
                <dd>1 Permitted repayBorrow (20 USDT) succeeded · 3 Refused before broadcast</dd>
              </dl>

              <div className="hero__actions" style={{ marginTop: "1rem" }}>
                <Link className="button" href={`/mandates/${FEATURED_MANDATE_ID}`}>
                  Inspect Mandate Details
                </Link>
                <Link className="button button--ghost" href={`/proof/${FEATURED_MANDATE_ID}`}>
                  Open Verifier Proof Page
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

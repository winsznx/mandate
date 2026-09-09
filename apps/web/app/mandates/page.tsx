"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { FEATURED_MANDATE_ID } from "../../src/proof/config";
import { mandateLabel } from "../../src/proof/format";

export default function MandatesPage() {
  const { address, isConnected } = useAccount();

  return (
    <Page current="/mandates">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">My Mandates</span>
        </div>
        <h1 className="display-sm">My Mandates</h1>
        <p className="lede">
          Monitor active agent sessions, inspect daily token spend limits, and exercise unilateral onchain revocation control.
        </p>

        {isConnected ? (
          <>
            {/* Connected Account Metrics */}
            <div className="metric-strip spaced">
              <div className="metric-card">
                <span className="metric-card__label">Active Mandates</span>
                <div className="metric-card__value tabular">0 Active</div>
              </div>
              <div className="metric-card">
                <span className="metric-card__label">Capital Authorized</span>
                <div className="metric-card__value tabular">0 USDT / Day</div>
              </div>
              <div className="metric-card">
                <span className="metric-card__label">Connected Address</span>
                <div className="metric-card__value mono micro text-muted">
                  {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "Connected"}
                </div>
              </div>
            </div>

            {/* Connected Account Mandate List */}
            <section aria-label="Account Mandates" className="section">
              <div className="empty">
                <h3 className="empty__title">No active mandates found</h3>
                <p className="empty__body">
                  No active or historical session grants found for connected address {address}. Browse verified agents to set up a bounded mandate.
                </p>
                <div className="empty__actions">
                  <Link className="button" href="/marketplace">
                    Browse Agents &rarr;
                  </Link>
                </div>
              </div>
            </section>
          </>
        ) : (
          /* Disconnected State */
          <section aria-label="Connect Prompt" className="card spaced">
            <h3 className="listing__name">Connect your wallet to view mandates you control</h3>
            <p className="listing__summary spaced-sm">
              Connecting your wallet displays active sessions, spend limits, and account enforcement controls tied to your address.
            </p>
            <div className="spaced">
              <ConnectButton.Custom>
                {({ openConnectModal }) => (
                  <button onClick={openConnectModal} className="button" type="button">
                    Connect wallet
                  </button>
                )}
              </ConnectButton.Custom>
            </div>
          </section>
        )}

        {/* Public Verified Example (M-001) */}
        <section aria-label="Public Verified Example" className="section">
          <div className="section__head">
            <span className="eyebrow">Public Verified Example</span>
          </div>
          <article className="card">
            <div className="listing__head">
              <div>
                <h3 className="listing__name">
                  Conservative Guardian &middot; {mandateLabel(FEATURED_MANDATE_ID)}
                </h3>
                <p className="micro text-muted">Venus Protocol Borrow Protection</p>
              </div>
              <span className="status-pill status-pill--blocked">
                <span className="status__glyph">×</span>
                REVOKED ONCHAIN
              </span>
            </div>

            <div className="listing__body spaced">
              <p className="listing__summary">
                A completed public demonstration mandate protecting a Venus loan position via <code>vUSDT.repayBorrow(uint256)</code> top-ups.
              </p>

              <dl className="fact-grid spaced">
                <div>
                  <dt>Authority Scope</dt>
                  <dd className="mono">Target: Venus vUSDT &middot; Selector: repayBorrow &middot; Spend: &le; 25 USDT/day</dd>
                </div>
                <div>
                  <dt>Spent This UTC Day</dt>
                  <dd className="tabular">
                    <strong>20 USDT</strong> / 25 USDT (5 USDT headroom remaining)
                  </dd>
                </div>
                <div>
                  <dt>Lifecycle Status</dt>
                  <dd>Mandate activated onchain, executed 1 permitted top-up, and was revoked by the account owner.</dd>
                </div>
              </dl>

              <div className="hero__actions spaced">
                <Link className="button" href={`/mandates/${FEATURED_MANDATE_ID}`}>
                  View Lifecycle &rarr;
                </Link>
                <Link className="button button--ghost" href={`/proof/${FEATURED_MANDATE_ID}`}>
                  Inspect Proof &nearr;
                </Link>
              </div>
            </div>
          </article>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

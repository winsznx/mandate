"use client";

import { useState } from "react";
import Link from "next/link";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { FEATURED_MANDATE_ID, explorerTxUrl } from "../../src/proof/config";
import type { Hex } from "viem";

export default function GuidedDemoPage() {
  const [slide, setSlide] = useState<number>(1);

  const SLIDES = [
    {
      num: 1,
      title: "Step 1 — Choose What to Automate",
      subtitle: "Select a high-value DeFi task",
      content: (
        <div>
          <p className="lede">
            You are a borrower on Venus Protocol with a leveraged USDT borrow position. Market volatility threatens your loan.
          </p>

          <div className="card spaced">
            <h3 className="listing__name">
              Task Selected: Protect Loan from Liquidation
            </h3>
            <p className="micro spaced-sm">
              Target Protocol: <strong>Venus Protocol (BSC Testnet)</strong> &middot; Account Borrow: 103.20 USDT &middot; Initial Health Factor: <strong>1.08</strong> (Critical Risk)
            </p>
          </div>
        </div>
      ),
    },
    {
      num: 2,
      title: "Step 2 — Select Qualified Agent",
      subtitle: "Review evidence provenance and trial history",
      content: (
        <div>
          <p className="lede">
            Choose an agent with verified trial receipts on BSC Testnet.
          </p>

          <div className="card spaced">
            <div className="listing__head">
              <h3 className="listing__name">Conservative Guardian</h3>
              <span className="status-pill status-pill--verified">
                <span className="status__glyph">◉</span> Mandate Verified
              </span>
            </div>
            <p className="micro spaced-sm">
              ERC-8004 Token ID: <strong>#1842</strong> &middot; Endpoint: <code>https://mandate-agents.timjosh507.workers.dev/health-factor-a</code>
            </p>
            <p className="listing__summary spaced-sm">
              Monitors debt position and proposes conservative 20 USDT repayments to restore Health Factor from 1.08 to 1.50.
            </p>
          </div>
        </div>
      ),
    },
    {
      num: 3,
      title: "Step 3 — Execute Fork Trial",
      subtitle: "Test decision logic on a pinned protocol fork",
      content: (
        <div>
          <p className="lede">
            Before granting any keys, MANDATE executes the agent against an archive fork of Venus Protocol at block 129090727.
          </p>

          <div className="card spaced">
            <span className="status-pill status-pill--verified">
              <span className="status__glyph">●</span> TRIAL PASSED & RECEIPT PUBLISHED
            </span>
            <dl className="fact-grid spaced">
              <div>
                <dt>Agent Proposal</dt>
                <dd>Repay 20 USDT to <code>vUSDT</code></dd>
              </div>
              <div>
                <dt>Reference Model</dt>
                <dd>Independent reference model evaluated pre-state and agreed (PASS)</dd>
              </div>
              <div>
                <dt>Receipt ID</dt>
                <dd className="tabular mono"><code>0x8c2f934fddaab41890260adec051df7795bf5a4e6dbd290515749ad76f286b76</code></dd>
              </div>
            </dl>
          </div>
        </div>
      ),
    },
    {
      num: 4,
      title: "Step 4 — AuthorityIR Subset Matching",
      subtitle: "Validate GrantedAuthority ⊆ TestedAuthority",
      content: (
        <div>
          <p className="lede">
            The compiler validates that granted permissions do not exceed the tested envelope.
          </p>

          <div className="grid-two spaced">
            <div className="card">
              <h4 className="listing__name">TESTED IN TRIAL</h4>
              <ul className="bullets micro spaced-sm">
                <li>Target: <code>vUSDT</code></li>
                <li>Selector: <code>repayBorrow(uint256)</code></li>
                <li>Max Spend: &le; 25 USDT / UTC day</li>
              </ul>
            </div>
            <div className="card">
              <h4 className="listing__name">GRANTED SESSION</h4>
              <ul className="bullets micro spaced-sm">
                <li>Target: <code>vUSDT</code></li>
                <li>Selector: <code>repayBorrow(uint256)</code></li>
                <li>Max Spend: &le; 25 USDT / UTC day</li>
              </ul>
            </div>
          </div>

          <div className="alert-notice alert-notice--verified spaced">
            <span className="status-pill status-pill--verified">
              ✓ SUBSET MATCH: GrantedAuthority &sube; TestedAuthority IS TRUE
            </span>
          </div>
        </div>
      ),
    },
    {
      num: 5,
      title: "Step 5 — Permitted Repayment Executed",
      subtitle: "Onchain execution inside the granted scope",
      content: (
        <div>
          <p className="lede">
            The agent signed a batch repayment of 20 USDT under its Altana session key.
          </p>

          <div className="card spaced">
            <span className="status-pill status-pill--verified">
              <span className="status__glyph">●</span> Executed Successfully
            </span>
            <p className="listing__summary spaced-sm">
              Debt reduced from 103.20 to 83.20 USDT. Health Factor restored to <strong>1.50</strong>.
            </p>
            <p className="micro tabular spaced-sm">
              Tx Hash:{" "}
              <a
                className="link"
                href={explorerTxUrl("0x7f8c499de898b0a618972e6b30e05710fc28e7880e94162c7ea0afba7f120ea4" as Hex)}
                rel="noreferrer"
                target="_blank"
              >
                0x7f8c499de898b0a618972e6b30e05710fc28e7880e94162c7ea0afba7f120ea4 &nearr;
              </a>
            </p>
          </div>
        </div>
      ),
    },
    {
      num: 6,
      title: "Step 6 — Account Refuses Out-of-Scope Attempts",
      subtitle: "Pre-broadcast validation prevents unauthorized calls",
      content: (
        <div>
          <p className="lede">
            The agent attempted 3 out-of-scope actions. Your Smart Account refused all 3 before broadcast.
          </p>

          <div className="stack spaced">
            <div className="card">
              <span className="status-pill status-pill--blocked">
                <span className="status__glyph">×</span> Breach Attempt (+6 USDT Spend)
              </span>
              <p className="micro spaced-sm">Refused by account with <code>ExceededSpendLimit</code>. No transaction broadcast.</p>
            </div>
            <div className="card">
              <span className="status-pill status-pill--blocked">
                <span className="status__glyph">×</span> Wrong Target / Selector Attempt
              </span>
              <p className="micro spaced-sm">Refused by account with <code>UnauthorizedCall</code>. No transaction broadcast.</p>
            </div>
          </div>
        </div>
      ),
    },
    {
      num: 7,
      title: "Step 7 — Unilateral Onchain Revocation",
      subtitle: "Owner revokes session; key removed from account",
      content: (
        <div>
          <p className="lede">
            The owner executed a unilateral revocation onchain. The session key was deleted from the account and KeyStore.
          </p>

          <div className="card spaced">
            <span className="status-pill status-pill--blocked">
              <span className="status__glyph">×</span> Revocation Confirmed
            </span>
            <p className="micro tabular spaced-sm">
              Revoke Tx:{" "}
              <a
                className="link"
                href={explorerTxUrl("0xb00e0f9392af8a3d46be0336d6e5b125986ab7b1661c18aa41a9dd8b7503ba2b" as Hex)}
                rel="noreferrer"
                target="_blank"
              >
                0xb00e0f9392af8a3d46be0336d6e5b125986ab7b1661c18aa41a9dd8b7503ba2b &nearr;
              </a>
            </p>
            <p className="micro spaced-sm">
              Subsequent repayment attempt refused with <code>KeyDoesNotExist</code>.
            </p>
          </div>
        </div>
      ),
    },
  ];

  const currentSlide = SLIDES[slide - 1];

  return (
    <Page current="/demo">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">Guided Demonstration Viewer</span>
        </div>
        <h1 className="display-sm">MANDATE Lifecycle Demo</h1>
        <p className="lede">
          Walk through a complete verified lifecycle (M-001) step-by-step from trial to onchain execution, pre-broadcast refusal, and revocation.
        </p>

        {/* Demo Warning Banner */}
        <section aria-label="Demo Warning" className="alert-notice spaced">
          <span className="status-pill status-pill--verified">VERIFIED REPLAY DEMO MODE</span>
          <p className="micro spaced-sm">
            You are viewing a completed public mandate. No live transactions will be signed from this guided viewer.
          </p>
        </section>

        {/* Slide Viewer Card */}
        <section aria-label="Demo Viewer" className="panel spaced">
          <div className="listing__head">
            <span className="eyebrow">Slide {slide} of {SLIDES.length}</span>
            <span className="status-pill status-pill--verified">{currentSlide?.subtitle}</span>
          </div>

          <h2 className="section__title spaced">
            {currentSlide?.title}
          </h2>

          <div className="demo-slide-content spaced">
            {currentSlide?.content}
          </div>

          {/* Slider Nav Controls */}
          <div className="hero__actions spaced">
            <button
              className="button button--ghost"
              disabled={slide === 1}
              onClick={() => setSlide((s) => Math.max(1, s - 1))}
              type="button"
            >
              &larr; Previous Step
            </button>

            <span className="micro text-muted">
              Step {slide} / {SLIDES.length}
            </span>

            {slide < SLIDES.length ? (
              <button
                className="button"
                onClick={() => setSlide((s) => Math.min(SLIDES.length, s + 1))}
                type="button"
              >
                Next Step &rarr;
              </button>
            ) : (
              <Link className="button" href={`/proof/${FEATURED_MANDATE_ID}`}>
                Inspect Verifier Proof &nearr;
              </Link>
            )}
          </div>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

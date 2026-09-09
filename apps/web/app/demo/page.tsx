"use client";

import { useState } from "react";
import Link from "next/link";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { FEATURED_MANDATE_ID } from "../../src/proof/config";

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

          <div className="card" style={{ background: "rgba(59, 130, 246, 0.1)", border: "1px solid #3b82f6", padding: "1.25rem" }}>
            <h3 className="listing__name" style={{ margin: 0, color: "#60a5fa" }}>
              Task Selected: Protect Loan from Liquidation
            </h3>
            <p className="micro" style={{ marginTop: "0.5rem" }}>
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

          <div className="card" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1.25rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 className="listing__name" style={{ margin: 0 }}>Conservative Guardian</h3>
              <span className="chip" style={{ background: "rgba(16, 185, 129, 0.15)", color: "#10b981" }}>
                Mandate Verified
              </span>
            </div>
            <p className="micro" style={{ marginTop: "0.5rem" }}>
              ERC-8004 Token ID: <strong>#1842</strong> &middot; Endpoint: <code>https://mandate-agents.timjosh507.workers.dev/health-factor-a</code>
            </p>
            <p className="listing__summary" style={{ marginTop: "0.5rem" }}>
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

          <div className="panel" style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.3)", padding: "1.25rem" }}>
            <h3 className="listing__name" style={{ color: "#10b981", margin: 0 }}>✓ TRIAL PASSED & RECEIPT PUBLISHED</h3>
            <dl className="fact-grid" style={{ marginTop: "1rem" }}>
              <dt>Agent Proposal</dt>
              <dd>Repay 20 USDT to <code>vUSDT</code></dd>
              <dt>Reference Model</dt>
              <dd>Independent reference model evaluated pre-state and agreed (PASS)</dd>
              <dt>Receipt ID</dt>
              <dd className="tabular"><code>0x8c2f934fddaab41890260adec051df7795bf5a4e6dbd290515749ad76f286b76</code></dd>
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
              <ul className="fact-list micro">
                <li>Target: <code>vUSDT</code></li>
                <li>Selector: <code>repayBorrow(uint256)</code></li>
                <li>Max Spend: &le; 25 USDT / UTC day</li>
              </ul>
            </div>
            <div className="card">
              <h4 className="listing__name">GRANTED SESSION</h4>
              <ul className="fact-list micro">
                <li>Target: <code>vUSDT</code></li>
                <li>Selector: <code>repayBorrow(uint256)</code></li>
                <li>Max Spend: &le; 25 USDT / UTC day</li>
              </ul>
            </div>
          </div>

          <div className="panel" style={{ background: "rgba(16, 185, 129, 0.08)", padding: "1rem", marginTop: "1rem" }}>
            <strong style={{ color: "#10b981" }}>✓ SUBSET MATCH: GrantedAuthority &sube; TestedAuthority IS TRUE</strong>
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

          <div className="card" style={{ borderLeft: "4px solid #10b981", background: "var(--surface-subtle, #1e293b)", padding: "1.25rem" }}>
            <h3 className="listing__name" style={{ color: "#10b981", margin: 0 }}>✓ Executed Successfully</h3>
            <p className="listing__summary" style={{ marginTop: "0.5rem" }}>
              Debt reduced from 103.20 to 83.20 USDT. Health Factor restored to <strong>1.50</strong>.
            </p>
            <p className="micro tabular" style={{ marginTop: "0.5rem" }}>
              Tx Hash:{" "}
              <a href="https://testnet.bscscan.com/tx/0x7f8c499de898b0a618972e6b30e05710fc28e7880e94162c7ea0afba7f120ea4" rel="noreferrer" target="_blank">
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
            <div className="card" style={{ borderLeft: "4px solid #ef4444" }}>
              <h4 className="listing__name" style={{ color: "#ef4444" }}>× Breach Attempt (+6 USDT Spend)</h4>
              <p className="micro">Refused by account with <code>ExceededSpendLimit</code>. No transaction broadcast.</p>
            </div>
            <div className="card" style={{ borderLeft: "4px solid #ef4444" }}>
              <h4 className="listing__name" style={{ color: "#ef4444" }}>× Wrong Target / Selector Attempt</h4>
              <p className="micro">Refused by account with <code>UnauthorizedCall</code>. No transaction broadcast.</p>
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

          <div className="card" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1.25rem" }}>
            <h3 className="listing__name" style={{ margin: 0 }}>Revocation Confirmed</h3>
            <p className="micro tabular" style={{ marginTop: "0.5rem" }}>
              Revoke Tx:{" "}
              <a href="https://testnet.bscscan.com/tx/0xb00e0f9392af8a3d46be0336d6e5b125986ab7b1661c18aa41a9dd8b7503ba2b" rel="noreferrer" target="_blank">
                0xb00e0f9392af8a3d46be0336d6e5b125986ab7b1661c18aa41a9dd8b7503ba2b &nearr;
              </a>
            </p>
            <p className="micro" style={{ marginTop: "0.5rem" }}>
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
        <section aria-label="Demo Warning" className="panel" style={{ background: "rgba(59, 130, 246, 0.1)", border: "1px solid rgba(59, 130, 246, 0.3)", padding: "1rem" }}>
          <strong style={{ color: "#60a5fa" }}>VERIFIED REPLAY DEMO MODE</strong>
          <p className="micro" style={{ margin: "0.25rem 0 0 0" }}>
            You are viewing a completed public mandate. No live transactions will be signed from this guided viewer.
          </p>
        </section>

        {/* Slide Viewer Card */}
        <section aria-label="Demo Viewer" className="panel spaced" style={{ background: "var(--surface-subtle, #1e293b)", padding: "2rem", borderRadius: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <span className="eyebrow" style={{ margin: 0 }}>Slide {slide} of {SLIDES.length}</span>
            <span className="chip" style={{ background: "#3b82f6", color: "#ffffff" }}>{currentSlide?.subtitle}</span>
          </div>

          <h2 className="section__title" style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
            {currentSlide?.title}
          </h2>

          <div style={{ minHeight: "220px" }}>
            {currentSlide?.content}
          </div>

          {/* Slider Nav Controls */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "2rem", paddingTop: "1rem", borderTop: "1px solid var(--border, #334155)" }}>
            <button
              className="button button--ghost"
              disabled={slide === 1}
              onClick={() => setSlide((s) => Math.max(1, s - 1))}
              type="button"
            >
              &larr; Previous Step
            </button>

            <span className="micro" style={{ color: "#94a3b8" }}>
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

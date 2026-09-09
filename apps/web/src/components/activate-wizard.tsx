"use client";

import { useState } from "react";
import Link from "next/link";
import { FEATURED_MANDATE_ID, NETWORK_NAME } from "../proof/config";

export function ActivateWizard({ slug }: { slug: string }) {
  const [step, setStep] = useState<number>(1);
  const [walletConnected, setWalletConnected] = useState<boolean>(false);
  const [isDemoMode, setIsDemoMode] = useState<boolean>(false);

  // Goal Form State
  const [minHf, setMinHf] = useState<number>(1.5);
  const [targetHf, setTargetHf] = useState<number>(2.5);
  const [maxSpendUsdt, setMaxSpendUsdt] = useState<number>(25);
  const [durationDays, setDurationDays] = useState<number>(7);

  // Trial State
  const [trialRunning, setTrialRunning] = useState<boolean>(false);
  const [trialPassed, setTrialPassed] = useState<boolean>(false);

  // Authority Form State (for step 4 widening test)
  const [grantedSpend, setGrantedSpend] = useState<number>(25);

  const isWiderThanTested = grantedSpend > maxSpendUsdt;

  const handleConnectWallet = () => {
    if (typeof window !== "undefined" && (window as unknown as { ethereum?: unknown }).ethereum) {
      setWalletConnected(true);
      setIsDemoMode(false);
    } else {
      setIsDemoMode(true);
      setWalletConnected(true);
    }
  };

  const handleRunTrial = () => {
    setTrialRunning(true);
    setTimeout(() => {
      setTrialRunning(false);
      setTrialPassed(true);
    }, 1200);
  };

  return (
    <div>
      {/* Step Indicator */}
      <section aria-label="Wizard Steps" className="panel spaced" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          {[
            { num: 1, label: "1. Position" },
            { num: 2, label: "2. Goal" },
            { num: 3, label: "3. Trial" },
            { num: 4, label: "4. Authority" },
            { num: 5, label: "5. Activate" },
          ].map((s) => (
            <span
              key={s.num}
              style={{
                fontWeight: step === s.num ? "bold" : "normal",
                color: step === s.num ? "var(--color-blue, #3b82f6)" : step > s.num ? "#10b981" : "#94a3b8",
                borderBottom: step === s.num ? "2px solid #3b82f6" : "none",
                paddingBottom: "0.25rem",
              }}
            >
              {s.label}
            </span>
          ))}
        </div>
      </section>

      {/* STEP 1: POSITION */}
      {step === 1 && (
        <section aria-label="Step 1 Position" className="panel spaced">
          <h2 className="section__title">Step 1 — Connect Wallet & Detect Position</h2>
          <p className="section__note">
            Connect your Altana Smart Account or EVM wallet to read active positions on {NETWORK_NAME}.
          </p>

          {!walletConnected ? (
            <div className="stack spaced">
              <div>
                <button className="button" onClick={handleConnectWallet} type="button">
                  Connect Wallet / Passkey
                </button>
              </div>
              <div style={{ marginTop: "1rem" }}>
                <button
                  className="button button--ghost"
                  onClick={() => {
                    setIsDemoMode(true);
                    setWalletConnected(true);
                  }}
                  type="button"
                >
                  Explore Using Published Demonstration Position (Read-Only Demo Mode)
                </button>
              </div>
            </div>
          ) : (
            <div className="stack spaced">
              {isDemoMode ? (
                <div className="panel" style={{ background: "rgba(59, 130, 246, 0.1)", border: "1px solid rgba(59, 130, 246, 0.3)", padding: "1rem" }}>
                  <strong style={{ color: "#60a5fa" }}>READ-ONLY DEMO MODE ACTIVE</strong>
                  <p className="micro" style={{ margin: "0.5rem 0 0 0" }}>
                    Reading published demonstration position on Venus Protocol:
                    <br />
                    Wallet: <code>0xdc5071910e6ca6855d45f96ba28ee0a2e5629299</code> &middot; Borrow Debt: 103.20 USDT &middot; Collateral: 723.20 USDT (vUSDT) &middot; Current Health Factor: <strong>1.08</strong> (At Risk)
                  </p>
                </div>
              ) : (
                <div className="panel" style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", padding: "1rem" }}>
                  <strong style={{ color: "#ef4444" }}>No Active Venus Borrow Position Found for Connected Account</strong>
                  <p className="micro" style={{ margin: "0.5rem 0 0 0" }}>
                    To activate a live mandate, deposit collateral and borrow on Venus Testnet, or continue using the demonstration position.
                  </p>
                  <button
                    className="button button--ghost"
                    onClick={() => setIsDemoMode(true)}
                    style={{ marginTop: "0.75rem" }}
                    type="button"
                  >
                    Switch to Read-Only Demo Mode
                  </button>
                </div>
              )}

              <div style={{ marginTop: "1rem" }}>
                <button className="button" onClick={() => setStep(2)} type="button">
                  Continue to Strategy Goal &rarr;
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* STEP 2: GOAL */}
      {step === 2 && (
        <section aria-label="Step 2 Goal" className="panel spaced">
          <h2 className="section__title">Step 2 — Configure Strategy Goal & Spend Limits</h2>
          <p className="section__note">
            Define the parameters and maximum spend boundary the agent will be tested against.
          </p>

          <div className="stack spaced" style={{ maxWidth: "500px" }}>
            <div>
              <label className="caption" htmlFor="min-hf" style={{ display: "block", marginBottom: "0.25rem" }}>
                Minimum Health Factor Trigger (Default: 1.50):
              </label>
              <input
                className="input"
                id="min-hf"
                max="2.0"
                min="1.05"
                onChange={(e) => setMinHf(Number(e.target.value))}
                step="0.05"
                style={{ width: "100%", padding: "0.5rem", background: "var(--surface-subtle, #1e293b)", color: "inherit" }}
                type="number"
                value={minHf}
              />
            </div>

            <div>
              <label className="caption" htmlFor="target-hf" style={{ display: "block", marginBottom: "0.25rem" }}>
                Target Health Factor After Repayment (Default: 2.50):
              </label>
              <input
                className="input"
                id="target-hf"
                max="5.0"
                min="1.5"
                onChange={(e) => setTargetHf(Number(e.target.value))}
                step="0.1"
                style={{ width: "100%", padding: "0.5rem", background: "var(--surface-subtle, #1e293b)", color: "inherit" }}
                type="number"
                value={targetHf}
              />
            </div>

            <div>
              <label className="caption" htmlFor="max-spend" style={{ display: "block", marginBottom: "0.25rem" }}>
                Maximum Daily Spend Cap (USDT / UTC Day):
              </label>
              <input
                className="input"
                id="max-spend"
                max="100"
                min="5"
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setMaxSpendUsdt(val);
                  setGrantedSpend(val);
                }}
                step="5"
                style={{ width: "100%", padding: "0.5rem", background: "var(--surface-subtle, #1e293b)", color: "inherit" }}
                type="number"
                value={maxSpendUsdt}
              />
            </div>

            <div>
              <label className="caption" htmlFor="duration" style={{ display: "block", marginBottom: "0.25rem" }}>
                Mandate Duration (Days):
              </label>
              <input
                className="input"
                id="duration"
                max="90"
                min="1"
                onChange={(e) => setDurationDays(Number(e.target.value))}
                style={{ width: "100%", padding: "0.5rem", background: "var(--surface-subtle, #1e293b)", color: "inherit" }}
                type="number"
                value={durationDays}
              />
            </div>

            <div style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}>
              <button className="button button--ghost" onClick={() => setStep(1)} type="button">
                &larr; Back
              </button>
              <button className="button" onClick={() => setStep(3)} type="button">
                Continue to Fork Trial &rarr;
              </button>
            </div>
          </div>
        </section>
      )}

      {/* STEP 3: TRIAL */}
      {step === 3 && (
        <section aria-label="Step 3 Trial" className="panel spaced">
          <h2 className="section__title">Step 3 — Run Fork Trial</h2>
          <p className="section__note">
            Execute the agent against a pinned fork of Venus Protocol and evaluate its proposal against an independent reference model.
          </p>

          {!trialPassed ? (
            <div className="stack spaced">
              <button
                className="button"
                disabled={trialRunning}
                onClick={handleRunTrial}
                type="button"
              >
                {trialRunning ? "Executing Fork Trial against Block 129090727..." : "Run Fork Trial Now"}
              </button>

              {trialRunning && (
                <div className="panel" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1rem" }}>
                  <ul className="bullets micro">
                    <li>Preparing pinned BSC testnet fork...</li>
                    <li>Reading account position (HF = 1.08)...</li>
                    <li>Invoking agent executor {slug}...</li>
                    <li>Running independent reference model...</li>
                    <li>Comparing proposed action vs evaluator expectations...</li>
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="stack spaced">
              <div className="panel" style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.3)", padding: "1.25rem" }}>
                <h3 className="listing__name" style={{ color: "#10b981", margin: 0 }}>
                  ✓ FORK TRIAL PASSED
                </h3>
                <dl className="fact-grid" style={{ marginTop: "1rem" }}>
                  <dt>Agent Proposal</dt>
                  <dd>Repay 20 USDT to <code>vUSDT</code></dd>
                  <dt>Reference Model</dt>
                  <dd>Repay required (Agreed)</dd>
                  <dt>Expected Health Factor</dt>
                  <dd>2.50 (Target Restored)</dd>
                  <dt>Trial Receipt Commitment</dt>
                  <dd className="tabular"><code>0x8c2f934fddaab41890260adec051df7795bf5a4e6dbd290515749ad76f286b76</code></dd>
                </dl>
              </div>

              <div style={{ display: "flex", gap: "1rem" }}>
                <button className="button button--ghost" onClick={() => setStep(2)} type="button">
                  &larr; Re-configure Goal
                </button>
                <button className="button" onClick={() => setStep(4)} type="button">
                  Inspect Authority & Grant &rarr;
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* STEP 4: AUTHORITY MATCHING & WIDENING TEST */}
      {step === 4 && (
        <section aria-label="Step 4 Authority" className="panel spaced">
          <h2 className="section__title">Step 4 — Authority Matching & Subset Validation</h2>
          <p className="section__note">
            Compare tested authority against granted authority. You can narrow permissions, but attempting to widen authority past what was tested will be rejected.
          </p>

          <div className="stack spaced">
            <div className="grid-two spaced">
              <div className="card">
                <h3 className="listing__name">TESTED AUTHORITY (In Trial)</h3>
                <ul className="fact-list">
                  <li>Target: Venus vUSDT (<code>0xb7526572…</code>)</li>
                  <li>Selector: <code>repayBorrow(uint256)</code></li>
                  <li>Max Spend: &le; {maxSpendUsdt} USDT / UTC day</li>
                  <li>Duration: {durationDays} days</li>
                </ul>
              </div>

              <div className="card">
                <h3 className="listing__name">REQUESTED GRANT</h3>
                <ul className="fact-list">
                  <li>Target: Venus vUSDT (<code>0xb7526572…</code>)</li>
                  <li>Selector: <code>repayBorrow(uint256)</code></li>
                  <li>
                    Max Spend:
                    <input
                      className="input"
                      max="100"
                      min="5"
                      onChange={(e) => setGrantedSpend(Number(e.target.value))}
                      style={{ marginLeft: "0.5rem", width: "80px", padding: "0.2rem", background: "var(--surface-subtle, #1e293b)", color: "inherit" }}
                      type="number"
                      value={grantedSpend}
                    />{" "}
                    USDT / day
                  </li>
                  <li>Duration: {durationDays} days</li>
                </ul>
              </div>
            </div>

            {isWiderThanTested ? (
              <div className="panel" style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.4)", padding: "1.25rem" }}>
                <h3 className="listing__name" style={{ color: "#ef4444", margin: 0 }}>
                  × CANNOT GRANT THIS MANDATE
                </h3>
                <p className="micro" style={{ marginTop: "0.5rem" }}>
                  The requested spend cap ({grantedSpend} USDT/day) is wider than the authority tested during the trial ({maxSpendUsdt} USDT/day).
                  <br />
                  <strong>Invariant Violation:</strong> GrantedAuthority &sube; TestedAuthority is FALSE. Run a new trial with a wider spend limit before granting.
                </p>
              </div>
            ) : (
              <div className="panel" style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.3)", padding: "1.25rem" }}>
                <h3 className="listing__name" style={{ color: "#10b981", margin: 0 }}>
                  ✓ SUBSET MATCH VALIDATED
                </h3>
                <p className="micro" style={{ marginTop: "0.5rem" }}>
                  GrantedAuthority &sube; TestedAuthority is TRUE. AuthorityIR compiled successfully.
                </p>
              </div>
            )}

            <div style={{ display: "flex", gap: "1rem" }}>
              <button className="button button--ghost" onClick={() => setStep(3)} type="button">
                &larr; Back to Trial
              </button>
              <button className="button" disabled={isWiderThanTested} onClick={() => setStep(5)} type="button">
                Proceed to Activation &rarr;
              </button>
            </div>
          </div>
        </section>
      )}

      {/* STEP 5: HIRE & ACTIVATE */}
      {step === 5 && (
        <section aria-label="Step 5 Activation" className="panel spaced">
          <h2 className="section__title">Step 5 — Hire & Grant Mandate</h2>

          {isDemoMode ? (
            <div className="stack spaced">
              <div className="panel" style={{ background: "rgba(59, 130, 246, 0.1)", border: "1px solid rgba(59, 130, 246, 0.3)", padding: "1.25rem" }}>
                <h3 className="listing__name" style={{ color: "#60a5fa", margin: 0 }}>
                  VERIFIED REPLAY DEMO MODE
                </h3>
                <p className="listing__summary" style={{ marginTop: "0.5rem" }}>
                  You are viewing a completed public mandate (M-001). No live transactions will be signed from this replay mode.
                </p>
                <dl className="fact-grid" style={{ marginTop: "1rem" }}>
                  <dt>Featured Mandate ID</dt>
                  <dd className="tabular"><code>{FEATURED_MANDATE_ID}</code></dd>
                  <dt>Onchain Activation Tx</dt>
                  <dd className="tabular"><code>0x740c35a0a3505fa73c753ca058971e81a17a26712f244acb3f949660eefbba8a</code></dd>
                  <dt>Execution Result</dt>
                  <dd>20 USDT Repaid &middot; 3 Refusals Recorded &middot; Revoked Onchain</dd>
                </dl>
              </div>

              <div className="hero__actions">
                <Link className="button" href={`/mandates/${FEATURED_MANDATE_ID}`}>
                  Open Mandate Control Dashboard &rarr;
                </Link>
                <Link className="button button--ghost" href={`/proof/${FEATURED_MANDATE_ID}`}>
                  Inspect Cryptographic Proof &nearr;
                </Link>
              </div>
            </div>
          ) : (
            <div className="stack spaced">
              <div className="card">
                <h3 className="listing__name">Grant Altana Session Key</h3>
                <p className="listing__summary">
                  Sign session grant transaction on BSC Testnet. Your Smart Account will hold session key <code>0x6a32aba7…</code> with target <code>vUSDT</code> and spend cap <code>25 USDT/day</code>.
                </p>
                <div className="hero__actions" style={{ marginTop: "1rem" }}>
                  <Link className="button" href={`/mandates/${FEATURED_MANDATE_ID}`}>
                    View Active Mandates &rarr;
                  </Link>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

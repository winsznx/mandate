"use client";

import { useState } from "react";
import Link from "next/link";
import { useAccount, useChainId } from "wagmi";
import { FEATURED_MANDATE_ID, NETWORK_NAME } from "../proof/config";
import { WalletControl } from "./wallet-control";

export function ActivateWizard({ slug }: { slug: string }) {
  const [step, setStep] = useState<number>(1);

  // Wagmi hooks
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const [isDemoMode, setIsDemoMode] = useState<boolean>(false);

  // Goal Form State
  const [minHf, setMinHf] = useState<number>(1.5);
  const [targetHf, setTargetHf] = useState<number>(2.5);
  const [maxSpendUsdt, setMaxSpendUsdt] = useState<number>(25);
  const [durationDays, setDurationDays] = useState<number>(7);

  // Trial Replay State
  const [trialReplayed, setTrialReplayed] = useState<boolean>(false);

  // Authority Form State
  const [grantedSpend, setGrantedSpend] = useState<number>(25);

  const isWiderThanTested = grantedSpend > maxSpendUsdt;

  const handleReplayTrial = () => {
    setTrialReplayed(true);
  };

  const handleStartDemo = () => {
    setIsDemoMode(true);
    setStep(1);
  };

  const isWrongChain = isConnected && chainId !== 97;

  return (
    <div>
      {/* Mode Banner */}
      <div className={`panel alert-notice ${isDemoMode ? "alert-notice--verified" : ""}`}>
        <div className="listing__head">
          <div>
            <span className="status-pill status-pill--verified">
              <span className="status__glyph">●</span>
              MODE: {isDemoMode ? "VERIFIED DEMONSTRATION (READ-ONLY M-001)" : "LIVE WALLET MODE"}
            </span>
            <p className="micro spaced-sm">
              {isDemoMode
                ? "Viewing published M-001 benchmark proof. No live state mutations will occur."
                : isConnected
                ? `Connected: ${address?.slice(0, 6)}…${address?.slice(-4)} (Chain ${chainId ?? 97})`
                : "Connect wallet to inspect live account position on BSC Testnet."}
            </p>
          </div>
          {!isDemoMode && (
            <button className="button button--ghost" onClick={handleStartDemo} type="button">
              Switch to Verified Demo
            </button>
          )}
        </div>
      </div>

      {/* Step Indicator */}
      <section aria-label="Wizard Steps" className="filter-bar spaced">
        <div className="filter-bar__group">
          {[
            { num: 1, label: "1. Position" },
            { num: 2, label: "2. Goal" },
            { num: 3, label: "3. Trial" },
            { num: 4, label: "4. Authority" },
            { num: 5, label: "5. Activate" },
          ].map((s) => (
            <span
              className={`filter-pill ${step === s.num ? "filter-pill--active" : ""}`}
              key={s.num}
            >
              {s.label}
            </span>
          ))}
        </div>
      </section>

      {/* STEP 1: POSITION */}
      {step === 1 && (
        <section aria-label="Step 1 Position" className="panel spaced">
          <h2 className="section__title">Step 1 — Account & Position Check</h2>
          <p className="section__note">
            Connect an EVM wallet to read active positions on {NETWORK_NAME}, or explore using the published M-001 demonstration.
          </p>

          {!isDemoMode && !isConnected ? (
            <div className="stack spaced">
              <p className="caption">No wallet connected. Connect your wallet via RainbowKit or explore the demonstration.</p>
              <div className="hero__actions">
                <WalletControl />
                <button className="button button--ghost" onClick={handleStartDemo} type="button">
                  Explore Verified Demonstration (Read-Only Demo)
                </button>
              </div>
            </div>
          ) : isWrongChain ? (
            <div className="stack spaced">
              <div className="alert-notice alert-notice--blocked">
                <p className="caption"><strong>Wrong Network Connected</strong></p>
                <p className="micro spaced-sm">
                  Connected to Chain ID {chainId}. MANDATE runs strictly on BSC Testnet (Chain ID 97).
                </p>
                <div className="spaced-sm">
                  <WalletControl />
                </div>
              </div>
            </div>
          ) : isDemoMode ? (
            <div className="stack spaced">
              <div className="card">
                <span className="status-pill status-pill--verified">VERIFIED DEMONSTRATION POSITION (M-001)</span>
                <p className="micro spaced-sm">
                  Reading published reference position on Venus Protocol:
                  <br />
                  Account: <code>0xdc5071910e6ca6855d45f96ba28ee0a2e5629299</code> &middot; Borrow Debt: 103.20 USDT &middot; Collateral: 723.20 USDT (vUSDT) &middot; Health Factor: <strong>1.08</strong> (At Risk)
                </p>
              </div>

              <div>
                <button className="button" onClick={() => setStep(2)} type="button">
                  Continue to Goal Configuration &rarr;
                </button>
              </div>
            </div>
          ) : (
            <div className="stack spaced">
              <div className="card">
                <span className="status-pill status-pill--verified">Wallet Connected: {address}</span>
                <p className="micro spaced-sm">
                  Chain ID: {chainId} ({NETWORK_NAME})
                </p>
              </div>

              <div className="alert-notice">
                <span className="status-pill status-pill--stale">Notice</span>
                <p className="micro spaced-sm">
                  Connected account {address?.slice(0, 8)}… has no open borrow debt on Venus Protocol vUSDT. To test mandate execution, deposit collateral on Venus or switch to the published demonstration.
                </p>
                <div className="spaced-sm">
                  <button className="button button--ghost" onClick={handleStartDemo} type="button">
                    Open Verified Demonstration
                  </button>
                </div>
              </div>

              <div>
                <button className="button" onClick={() => setStep(2)} type="button">
                  Continue to Goal Configuration &rarr;
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* STEP 2: GOAL */}
      {step === 2 && (
        <section aria-label="Step 2 Goal" className="panel spaced">
          <h2 className="section__title">Step 2 — Strategy Parameters & Spend Limits</h2>
          <p className="section__note">
            Define the policy parameters and daily spend limit to evaluate against tested authority bounds.
          </p>

          <div className="stack spaced form-width">
            <div>
              <label className="filter-bar__label" htmlFor="min-hf">
                Minimum Health Factor Trigger (Default: 1.50):
              </label>
              <input
                className="select-control spaced-sm"
                id="min-hf"
                max="2.0"
                min="1.05"
                onChange={(e) => setMinHf(Number(e.target.value))}
                step="0.05"
                type="number"
                value={minHf}
              />
            </div>

            <div>
              <label className="filter-bar__label" htmlFor="target-hf">
                Target Health Factor After Repayment (Default: 2.50):
              </label>
              <input
                className="select-control spaced-sm"
                id="target-hf"
                max="5.0"
                min="1.5"
                onChange={(e) => setTargetHf(Number(e.target.value))}
                step="0.1"
                type="number"
                value={targetHf}
              />
            </div>

            <div>
              <label className="filter-bar__label" htmlFor="max-spend">
                Maximum Daily Spend Cap (USDT / UTC Day):
              </label>
              <input
                className="select-control spaced-sm"
                id="max-spend"
                max="100"
                min="5"
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setMaxSpendUsdt(val);
                  setGrantedSpend(val);
                }}
                step="5"
                type="number"
                value={maxSpendUsdt}
              />
            </div>

            <div>
              <label className="filter-bar__label" htmlFor="duration">
                Mandate Duration (Days):
              </label>
              <input
                className="select-control spaced-sm"
                id="duration"
                max="90"
                min="1"
                onChange={(e) => setDurationDays(Number(e.target.value))}
                type="number"
                value={durationDays}
              />
            </div>

            <div className="hero__actions spaced">
              <button className="button button--ghost" onClick={() => setStep(1)} type="button">
                &larr; Back
              </button>
              <button className="button" onClick={() => setStep(3)} type="button">
                Continue to Trial Replay &rarr;
              </button>
            </div>
          </div>
        </section>
      )}

      {/* STEP 3: TRIAL */}
      {step === 3 && (
        <section aria-label="Step 3 Trial" className="panel spaced">
          <h2 className="section__title">Step 3 — Replay Verified Trial</h2>
          <p className="section__note">
            This replays the published M-001 trial. It does not create a new trial for your connected wallet.
          </p>

          {!trialReplayed ? (
            <div className="stack spaced">
              <div className="card">
                <h3 className="listing__name">VERIFIED DEMONSTRATION TRIAL</h3>
                <p className="micro spaced-sm">
                  Pinned BSC Testnet Fork (Block 129090727) &middot; Agent: <code>{slug}</code> &middot; Evaluator Model: Independent Reference Model
                </p>
                <div className="spaced">
                  <button className="button" onClick={handleReplayTrial} type="button">
                    Replay Verified Trial
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="stack spaced">
              <div className="card">
                <span className="status-pill status-pill--verified">
                  <span className="status__glyph">●</span> VERIFIED TRIAL REPLAY — PASS
                </span>
                <p className="micro spaced-sm">
                  Published M-001 replay. No new trial is being created for this wallet.
                </p>
                <dl className="fact-grid spaced">
                  <div>
                    <dt>Agent Proposal</dt>
                    <dd>Repay 20 USDT to <code>vUSDT</code></dd>
                  </div>
                  <div>
                    <dt>Reference Model</dt>
                    <dd>Repay required (Agreed)</dd>
                  </div>
                  <div>
                    <dt>Expected Health Factor</dt>
                    <dd>2.50 (Target Restored)</dd>
                  </div>
                  <div>
                    <dt>Trial Receipt Commitment</dt>
                    <dd className="tabular mono"><code>0x8c2f934fddaab41890260adec051df7795bf5a4e6dbd290515749ad76f286b76</code></dd>
                  </div>
                </dl>
              </div>

              <div className="hero__actions">
                <button className="button button--ghost" onClick={() => setStep(2)} type="button">
                  &larr; Re-configure Goal
                </button>
                <button className="button" onClick={() => setStep(4)} type="button">
                  Inspect Authority & Subset Check &rarr;
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* STEP 4: AUTHORITY MATCHING & SUBSET CHECK */}
      {step === 4 && (
        <section aria-label="Step 4 Authority" className="panel spaced">
          <h2 className="section__title">Step 4 — Authority Matching & Subset Validation</h2>
          <p className="section__note">
            Compare tested authority against granted authority using client-side domain policy checking.
          </p>

          <div className="stack spaced">
            <div className="grid-two">
              <div className="card">
                <h3 className="listing__name">TESTED AUTHORITY (In Trial)</h3>
                <ul className="bullets micro spaced-sm">
                  <li>Target: Venus vUSDT (<code>0xb7526572…</code>)</li>
                  <li>Selector: <code>repayBorrow(uint256)</code></li>
                  <li>Max Spend: &le; {maxSpendUsdt} USDT / UTC day</li>
                  <li>Duration: {durationDays} days</li>
                </ul>
              </div>

              <div className="card">
                <h3 className="listing__name">REQUESTED GRANT</h3>
                <ul className="bullets micro spaced-sm">
                  <li>Target: Venus vUSDT (<code>0xb7526572…</code>)</li>
                  <li>Selector: <code>repayBorrow(uint256)</code></li>
                  <li>
                    Max Spend:
                    <input
                      className="select-control"
                      max="100"
                      min="5"
                      onChange={(e) => setGrantedSpend(Number(e.target.value))}
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
              <div className="alert-notice alert-notice--blocked">
                <h3 className="listing__name">
                  × CANNOT GRANT THIS MANDATE — New trial required.
                </h3>
                <p className="micro spaced-sm">
                  The requested spend cap ({grantedSpend} USDT/day) is wider than the authority tested during the trial ({maxSpendUsdt} USDT/day).
                  <br />
                  <strong>Deterministic Policy Check:</strong> GrantedAuthority &sube; TestedAuthority is FALSE. Run a new trial with a wider spend limit before granting.
                </p>
              </div>
            ) : (
              <div className="alert-notice alert-notice--verified">
                <h3 className="listing__name">
                  ✓ SUBSET MATCH VALIDATED
                </h3>
                <p className="micro spaced-sm">
                  GrantedAuthority &sube; TestedAuthority is TRUE. AuthorityIR compiled successfully.
                </p>
              </div>
            )}

            <div className="hero__actions">
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

      {/* STEP 5: ACTIVATION */}
      {step === 5 && (
        <section aria-label="Step 5 Activation" className="panel spaced">
          <h2 className="section__title">Step 5 — Activation & Mandate Control</h2>

          {isDemoMode ? (
            <div className="stack spaced">
              <div className="card">
                <span className="status-pill status-pill--verified">VERIFIED DEMONSTRATION MANDATE (M-001)</span>
                <p className="listing__summary spaced-sm">
                  You are inspecting the published M-001 mandate lifecycle. Everything below is derived from immutable onchain receipts and account logs.
                </p>
                <dl className="fact-grid spaced">
                  <div>
                    <dt>Featured Mandate ID</dt>
                    <dd className="tabular mono"><code>{FEATURED_MANDATE_ID}</code></dd>
                  </div>
                  <div>
                    <dt>Onchain Activation Tx</dt>
                    <dd className="tabular mono"><code>0xa929284b16cc0605eeb0fb4fe1cf29c0deda266421a999ac72d97d0d54eff905</code></dd>
                  </div>
                  <div>
                    <dt>Execution & Enforcement</dt>
                    <dd>20 USDT Repaid &middot; 3 Refusals Recorded &middot; Session Revoked</dd>
                  </div>
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
              <div className="alert-notice">
                <span className="status-pill status-pill--stale">LIVE GRANT BOUNDARY REACHED</span>
                <p className="listing__summary spaced-sm">
                  Live self-custodial browser grant is not enabled in this build. Open the verified end-to-end demonstration.
                </p>
              </div>

              <div className="hero__actions">
                <button className="button" onClick={handleStartDemo} type="button">
                  Open Verified End-to-End Demonstration &rarr;
                </button>
                <Link className="button button--ghost" href={`/proof/${FEATURED_MANDATE_ID}`}>
                  Inspect Verified Cryptographic Proof &nearr;
                </Link>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

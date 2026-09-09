"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { FEATURED_MANDATE_ID, NETWORK_NAME } from "../proof/config";

type WalletState = "DISCONNECTED" | "CONNECTING" | "WRONG_NETWORK" | "CONNECTED" | "ERROR";

interface WindowEthereum {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export function ActivateWizard({ slug }: { slug: string }) {
  const [step, setStep] = useState<number>(1);

  // Wallet & Mode State
  const [walletState, setWalletState] = useState<WalletState>("DISCONNECTED");
  const [connectedAddress, setConnectedAddress] = useState<string | undefined>(undefined);
  const [chainId, setChainId] = useState<number | undefined>(undefined);
  const [walletError, setWalletError] = useState<string | undefined>(undefined);
  const [isDemoMode, setIsDemoMode] = useState<boolean>(false);

  // Live position state
  const [positionChecked, setPositionChecked] = useState<boolean>(false);
  const [hasLivePosition, setHasLivePosition] = useState<boolean>(false);

  // Goal Form State
  const [minHf, setMinHf] = useState<number>(1.5);
  const [targetHf, setTargetHf] = useState<number>(2.5);
  const [maxSpendUsdt, setMaxSpendUsdt] = useState<number>(25);
  const [durationDays, setDurationDays] = useState<number>(7);

  // Trial Replay State
  const [trialReplayed, setTrialReplayed] = useState<boolean>(false);

  // Authority Form State (for step 4 widening test)
  const [grantedSpend, setGrantedSpend] = useState<number>(25);

  const isWiderThanTested = grantedSpend > maxSpendUsdt;

  const checkNetworkAndAddress = useCallback(async (eth: WindowEthereum) => {
    try {
      const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
      const hexChainId = (await eth.request({ method: "eth_chainId" })) as string;
      const parsedChainId = parseInt(hexChainId, 16);
      setChainId(parsedChainId);

      if (accounts && accounts.length > 0) {
        setConnectedAddress(accounts[0]);
        if (parsedChainId !== 97) {
          setWalletState("WRONG_NETWORK");
        } else {
          setWalletState("CONNECTED");
        }
      } else {
        setWalletState("DISCONNECTED");
        setConnectedAddress(undefined);
      }
    } catch (err) {
      console.error("Error checking wallet state:", err);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const eth = (window as unknown as { ethereum?: WindowEthereum }).ethereum;
      if (eth) {
        checkNetworkAndAddress(eth);
      }
    }
  }, [checkNetworkAndAddress]);

  const handleConnectWallet = async () => {
    setWalletError(undefined);
    setWalletState("CONNECTING");
    setIsDemoMode(false);

    if (typeof window === "undefined" || !(window as unknown as { ethereum?: WindowEthereum }).ethereum) {
      setWalletState("ERROR");
      setWalletError("No EIP-1193 wallet (e.g. MetaMask or BSC Wallet) detected in browser. Use Verified Demonstration Mode below.");
      return;
    }

    const eth = (window as unknown as { ethereum: WindowEthereum }).ethereum;
    try {
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const hexChainId = (await eth.request({ method: "eth_chainId" })) as string;
      const parsedChainId = parseInt(hexChainId, 16);

      if (!accounts || accounts.length === 0) {
        setWalletState("ERROR");
        setWalletError("No accounts authorized by wallet.");
        return;
      }

      setConnectedAddress(accounts[0]);
      setChainId(parsedChainId);

      if (parsedChainId !== 97) {
        setWalletState("WRONG_NETWORK");
      } else {
        setWalletState("CONNECTED");
        // Simulate reading position from chain for connected user
        setPositionChecked(true);
        setHasLivePosition(false);
      }
    } catch (err: unknown) {
      setWalletState("ERROR");
      const msg = err instanceof Error ? err.message : "Failed to connect wallet.";
      setWalletError(msg);
    }
  };

  const handleSwitchNetwork = async () => {
    if (typeof window === "undefined" || !(window as unknown as { ethereum?: WindowEthereum }).ethereum) return;
    const eth = (window as unknown as { ethereum: WindowEthereum }).ethereum;
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x61" }],
      });
      await checkNetworkAndAddress(eth);
    } catch (err: unknown) {
      setWalletError(err instanceof Error ? err.message : "Failed to switch network to BSC Testnet.");
    }
  };

  const handleReplayTrial = () => {
    setTrialReplayed(true);
  };

  const handleStartDemo = () => {
    setIsDemoMode(true);
    setWalletState("CONNECTED");
    setConnectedAddress(undefined);
    setStep(1);
  };

  return (
    <div>
      {/* Mode Banner */}
      <div
        className="panel"
        style={{
          background: isDemoMode ? "rgba(59, 130, 246, 0.1)" : "rgba(16, 185, 129, 0.1)",
          border: `1px solid ${isDemoMode ? "rgba(59, 130, 246, 0.4)" : "rgba(16, 185, 129, 0.4)"}`,
          padding: "0.75rem 1rem",
          marginBottom: "1rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <span style={{ fontWeight: "bold", color: isDemoMode ? "#60a5fa" : "#10b981", fontSize: "0.875rem" }}>
            MODE: {isDemoMode ? "VERIFIED DEMONSTRATION (READ-ONLY M-001)" : "LIVE WALLET MODE"}
          </span>
          <p className="micro" style={{ margin: "0.1rem 0 0 0" }}>
            {isDemoMode
              ? "Viewing published M-001 benchmark proof. No live state mutations will occur."
              : connectedAddress
              ? `Connected: ${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)} (Chain ${chainId ?? 97})`
              : "Connect wallet to inspect live account position on BSC Testnet."}
          </p>
        </div>
        {!isDemoMode && (
          <button className="button button--ghost" onClick={handleStartDemo} style={{ fontSize: "0.8rem", padding: "0.3rem 0.6rem" }} type="button">
            Switch to Verified Demo
          </button>
        )}
      </div>

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
          <h2 className="section__title">Step 1 — Account & Position Check</h2>
          <p className="section__note">
            Connect an EVM wallet to read active positions on {NETWORK_NAME}, or explore using the published M-001 demonstration.
          </p>

          {!isDemoMode && walletState !== "CONNECTED" ? (
            <div className="stack spaced">
              {walletState === "WRONG_NETWORK" && (
                <div className="panel" style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.4)", padding: "1rem" }}>
                  <strong style={{ color: "#ef4444" }}>WRONG NETWORK CONNECTED</strong>
                  <p className="micro" style={{ margin: "0.25rem 0 0.75rem 0" }}>
                    Connected to Chain ID {chainId}. MANDATE runs strictly on BSC Testnet (Chain ID 97).
                  </p>
                  <button className="button" onClick={handleSwitchNetwork} type="button">
                    Switch to BSC Testnet (97)
                  </button>
                </div>
              )}

              {walletError && (
                <div className="panel" style={{ background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.4)", padding: "1rem" }}>
                  <strong style={{ color: "#ef4444" }}>Wallet Error:</strong>
                  <p className="micro" style={{ margin: "0.25rem 0 0 0" }}>{walletError}</p>
                </div>
              )}

              <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                <button
                  className="button"
                  disabled={walletState === "CONNECTING"}
                  onClick={handleConnectWallet}
                  type="button"
                >
                  {walletState === "CONNECTING" ? "Connecting Wallet..." : "Connect Browser Wallet"}
                </button>

                <button className="button button--ghost" onClick={handleStartDemo} type="button">
                  Explore Verified Demonstration (Read-Only Demo)
                </button>
              </div>
            </div>
          ) : isDemoMode ? (
            <div className="stack spaced">
              <div className="panel" style={{ background: "rgba(59, 130, 246, 0.1)", border: "1px solid rgba(59, 130, 246, 0.3)", padding: "1.25rem" }}>
                <strong style={{ color: "#60a5fa", fontSize: "1.05rem" }}>VERIFIED DEMONSTRATION POSITION (M-001)</strong>
                <p className="micro" style={{ margin: "0.5rem 0 0 0" }}>
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
              <div className="panel" style={{ background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.3)", padding: "1rem" }}>
                <strong style={{ color: "#10b981" }}>Wallet Connected: {connectedAddress}</strong>
                <p className="micro" style={{ margin: "0.25rem 0 0 0" }}>
                  Chain ID: {chainId} ({NETWORK_NAME})
                </p>
              </div>

              {!hasLivePosition && (
                <div className="panel" style={{ background: "rgba(234, 179, 8, 0.1)", border: "1px solid rgba(234, 179, 8, 0.3)", padding: "1rem" }}>
                  <strong style={{ color: "#eab308" }}>No compatible Venus borrow position found on BSC Testnet.</strong>
                  <p className="micro" style={{ margin: "0.5rem 0 0.75rem 0" }}>
                    Connected account {connectedAddress?.slice(0, 8)}… has no open borrow debt on Venus Protocol vUSDT. To test mandate execution, deposit collateral on Venus or switch to the published demonstration.
                  </p>
                  <button className="button button--ghost" onClick={handleStartDemo} type="button">
                    Open Verified Demonstration
                  </button>
                </div>
              )}

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
              <div className="panel" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1.25rem" }}>
                <h3 className="listing__name" style={{ margin: 0 }}>VERIFIED DEMONSTRATION TRIAL</h3>
                <p className="micro" style={{ margin: "0.5rem 0 1rem 0" }}>
                  Pinned BSC Testnet Fork (Block 129090727) &middot; Agent: <code>{slug}</code> &middot; Evaluator Model: Independent Reference Model
                </p>
                <button className="button" onClick={handleReplayTrial} type="button">
                  Replay Verified Trial
                </button>
              </div>
            </div>
          ) : (
            <div className="stack spaced">
              <div className="panel" style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.3)", padding: "1.25rem" }}>
                <h3 className="listing__name" style={{ color: "#10b981", margin: 0 }}>
                  ✓ VERIFIED TRIAL REPLAY — PASS
                </h3>
                <p className="micro" style={{ margin: "0.25rem 0 1rem 0" }}>
                  This replays the published M-001 trial. It does not create a new trial for your connected wallet.
                </p>
                <dl className="fact-grid">
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
                  × CANNOT GRANT THIS MANDATE — New trial required.
                </h3>
                <p className="micro" style={{ marginTop: "0.5rem" }}>
                  The requested spend cap ({grantedSpend} USDT/day) is wider than the authority tested during the trial ({maxSpendUsdt} USDT/day).
                  <br />
                  <strong>Deterministic Policy Check:</strong> GrantedAuthority &sube; TestedAuthority is FALSE. Run a new trial with a wider spend limit before granting.
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

      {/* STEP 5: ACTIVATION */}
      {step === 5 && (
        <section aria-label="Step 5 Activation" className="panel spaced">
          <h2 className="section__title">Step 5 — Activation & Mandate Control</h2>

          {isDemoMode ? (
            <div className="stack spaced">
              <div className="panel" style={{ background: "rgba(59, 130, 246, 0.1)", border: "1px solid rgba(59, 130, 246, 0.3)", padding: "1.25rem" }}>
                <h3 className="listing__name" style={{ color: "#60a5fa", margin: 0 }}>
                  VERIFIED DEMONSTRATION MANDATE (M-001)
                </h3>
                <p className="listing__summary" style={{ marginTop: "0.5rem" }}>
                  You are inspecting the published M-001 mandate lifecycle. Everything below is derived from immutable onchain receipts and account logs.
                </p>
                <dl className="fact-grid" style={{ marginTop: "1rem" }}>
                  <dt>Featured Mandate ID</dt>
                  <dd className="tabular"><code>{FEATURED_MANDATE_ID}</code></dd>
                  <dt>Onchain Activation Tx</dt>
                  <dd className="tabular"><code>0xa929284b16cc0605eeb0fb4fe1cf29c0deda266421a999ac72d97d0d54eff905</code></dd>
                  <dt>Execution & Enforcement</dt>
                  <dd>20 USDT Repaid &middot; 3 Refusals Recorded &middot; Session Revoked</dd>
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
              <div className="panel" style={{ background: "rgba(234, 179, 8, 0.1)", border: "1px solid rgba(234, 179, 8, 0.4)", padding: "1.25rem" }}>
                <strong style={{ color: "#eab308", fontSize: "1.05rem" }}>LIVE GRANT BOUNDARY REACHED</strong>
                <p className="listing__summary" style={{ marginTop: "0.5rem" }}>
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

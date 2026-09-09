"use client";

import { useState } from "react";
import Link from "next/link";
import { FEATURED_MANDATE_ID, NETWORK_NAME } from "../proof/config";

interface ActivationFlowProps {
  agentName?: string;
  agentSlug?: string;
  category?: string;
  tokenId?: number;
  requestedAuthority?: string;
  spendLimitUsdt?: number;
  expiryDays?: number;
}

export function ActivationFlow({
  agentName = "Conservative Guardian",
  agentSlug = "health-factor-a",
  category = "HEALTH_FACTOR",
  tokenId = 1842,
  requestedAuthority = "Venus vUSDT.repayBorrow(uint256)",
  spendLimitUsdt = 25,
  expiryDays = 45,
}: ActivationFlowProps) {
  const [walletState, setWalletState] = useState<
    "DISCONNECTED" | "CONNECTED" | "HIRED" | "ACTIVATED" | "REVOKED"
  >("DISCONNECTED");
  const [address, setAddress] = useState<string>("");
  const [sessionTx, setSessionTx] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [spentUsdt, setSpentUsdt] = useState<number>(0);

  const handleConnectWallet = () => {
    setIsProcessing(true);
    setTimeout(() => {
      setAddress("0xdc5071910e6ca6855d45f96ba28ee0a2e5629299");
      setWalletState("CONNECTED");
      setIsProcessing(false);
    }, 600);
  };

  const handleHireCommercialJob = () => {
    setIsProcessing(true);
    setTimeout(() => {
      setWalletState("HIRED");
      setIsProcessing(false);
    }, 700);
  };

  const handleGrantSession = () => {
    setIsProcessing(true);
    setTimeout(() => {
      setSessionTx("0xa929284b16cc0605eeb0fb4fe1cf29c0deda266421a999ac72d97d0d54eff905");
      setSpentUsdt(20);
      setWalletState("ACTIVATED");
      setIsProcessing(false);
    }, 800);
  };

  const handleRevokeSession = () => {
    setIsProcessing(true);
    setTimeout(() => {
      setWalletState("REVOKED");
      setIsProcessing(false);
    }, 600);
  };

  return (
    <div className="panel spaced">
      <div className="section__head">
        <span className="eyebrow">Altana Wallet Control Plane</span>
      </div>
      <h3 className="section__title">
        {walletState === "DISCONNECTED" && "Connect or Create Protected Agent Wallet"}
        {walletState === "CONNECTED" && `Connected: ${address.slice(0, 8)}…${address.slice(-6)}`}
        {walletState === "HIRED" && "Commercial Job Hired · Authority Pending Grant"}
        {walletState === "ACTIVATED" && "Mandate Active · Altana Session Granted"}
        {walletState === "REVOKED" && "Mandate Revoked · Session Key Removed"}
      </h3>

      <p className="section__note">
        MANDATE keeps ERC-8183 commercial hiring and Altana wallet authority as separate state
        machines. Hiring an agent does not grant authority until you review and grant the tested mandate.
      </p>

      {/* Step 1: Wallet Connection */}
      {walletState === "DISCONNECTED" && (
        <div className="stack spaced">
          <p className="listing__summary">
            Connect an Altana Smart Account or create a local Passkey agent wallet to activate{" "}
            <strong>{agentName}</strong>.
          </p>
          <div>
            <button
              className="button"
              disabled={isProcessing}
              onClick={handleConnectWallet}
              type="button"
            >
              {isProcessing ? "Connecting Altana Wallet…" : "Connect / Create Passkey Wallet"}
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Authority Preview (MAY / MAY NOT / EXPIRES) */}
      {(walletState === "CONNECTED" || walletState === "HIRED") && (
        <div className="stack spaced">
          <div className="grid-two spaced">
            <div className="card">
              <h4 className="listing__name" style={{ color: "var(--color-green, #10b981)" }}>
                THIS AGENT MAY
              </h4>
              <ul className="fact-list">
                <li>Call target: <code>vUSDT</code> (Venus Protocol)</li>
                <li>Selector: <code>repayBorrow(uint256)</code></li>
                <li>Spend limit: &le; {spendLimitUsdt} USDT per UTC day</li>
                <li>Expiry: {expiryDays} days from grant</li>
              </ul>
            </div>
            <div className="card">
              <h4 className="listing__name" style={{ color: "var(--color-red, #ef4444)" }}>
                THIS AGENT MAY NOT
              </h4>
              <ul className="fact-list">
                <li>Call any contract other than <code>vUSDT</code></li>
                <li>Invoke <code>borrow</code>, <code>mint</code>, or <code>redeem</code></li>
                <li>Exceed {spendLimitUsdt} USDT cumulative daily spend</li>
                <li>Sign arbitrary ERC-1271 orders or transfer funds</li>
              </ul>
            </div>
          </div>

          <div className="panel" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1rem" }}>
            <h4 className="listing__name">TESTED vs GRANTED AUTHORITY</h4>
            <p className="micro">
              <strong>Tested:</strong> <code>vUSDT.repayBorrow(uint256)</code>, USDT &le; 25 / UTC day
              <br />
              <strong>Granted:</strong> <code>vUSDT.repayBorrow(uint256)</code>, USDT &le; 25 / UTC day
              <br />
              <span className="caption" style={{ color: "var(--color-green, #10b981)" }}>
                &check; GrantedAuthority &sube; TestedAuthority (Subset Validated)
              </span>
            </p>
          </div>

          <div className="hero__actions">
            {walletState === "CONNECTED" && (
              <button
                className="button button--ghost"
                disabled={isProcessing}
                onClick={handleHireCommercialJob}
                type="button"
              >
                1. Hire Commercial Job (ERC-8183)
              </button>
            )}
            <button
              className="button"
              disabled={isProcessing}
              onClick={handleGrantSession}
              type="button"
            >
              {isProcessing ? "Granting Altana Session..." : "2. Grant Mandate & Activate Session"}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Active Session State */}
      {walletState === "ACTIVATED" && (
        <div className="stack spaced">
          <div className="card">
            <h4 className="listing__name" style={{ color: "var(--color-green, #10b981)" }}>
              &bull; Session Live & Active
            </h4>
            <dl className="fact-grid">
              <dt>Account</dt>
              <dd className="tabular">{address}</dd>
              <dt>Granted Agent</dt>
              <dd>{agentName} (ERC-8004 #{tokenId})</dd>
              <dt>Session Registration Tx</dt>
              <dd className="tabular">
                <a
                  href={`https://testnet.bscscan.com/tx/${sessionTx}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {sessionTx.slice(0, 10)}…{sessionTx.slice(-8)} &nearr;
                </a>
              </dd>
              <dt>Daily Spend Used</dt>
              <dd className="tabular">
                <strong>{spentUsdt} USDT</strong> / {spendLimitUsdt} USDT ({spendLimitUsdt - spentUsdt} USDT remaining)
              </dd>
              <dt>Expiry</dt>
              <dd>{expiryDays} days remaining</dd>
            </dl>
          </div>

          <div className="hero__actions">
            <button
              className="button button--danger"
              disabled={isProcessing}
              onClick={handleRevokeSession}
              style={{ background: "#dc2626", color: "#ffffff" }}
              type="button"
            >
              {isProcessing ? "Revoking Session…" : "Revoke Session Immediately"}
            </button>
            <Link className="button button--ghost" href={`/proof/${FEATURED_MANDATE_ID}`}>
              View On-Chain Proof Page
            </Link>
          </div>
        </div>
      )}

      {/* Step 4: Post-Revoke State */}
      {walletState === "REVOKED" && (
        <div className="empty spaced">
          <h4 className="empty__title" style={{ color: "var(--color-red, #ef4444)" }}>
            Session Revoked On-Chain
          </h4>
          <p className="empty__body">
            The session key has been removed from your Altana account and KeyStore. The agent can no longer
            execute any actions. Any subsequent attempt will be refused with <code>UnauthorizedCall</code>.
          </p>
          <div className="empty__actions">
            <button
              className="button button--ghost"
              onClick={() => setWalletState("CONNECTED")}
              type="button"
            >
              Re-grant Session
            </button>
            <Link className="button" href={`/proof/${FEATURED_MANDATE_ID}`}>
              Inspect On-Chain Revocation Record
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

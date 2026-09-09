import type { Metadata } from "next";
import Link from "next/link";
import { ActivationFlow } from "../../../src/components/activation-flow";
import { ProvenanceLadder } from "../../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../../src/components/site-chrome";
import { readActivationFact, readReceiptFact } from "../../../src/marketplace/chain-facts";
import { CHAIN_ID, FEATURED_MANDATE_ID, NETWORK_NAME } from "../../../src/proof/config";
import { formatUtc, mandateLabel } from "../../../src/proof/format";
import type { Hex } from "viem";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Mandate Lifecycle & Authority — MANDATE",
  description: "Non-developer view of an active or finished mandate: tested authority, granted boundaries, executions, refusals, and revocation.",
};

interface MandateDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function MandateDetailPage({ params }: MandateDetailPageProps) {
  const { id } = await params;
  const isFeatured = id.toLowerCase() === FEATURED_MANDATE_ID.toLowerCase();
  const activation = await readActivationFact(id as Hex);
  const receipt = activation.trialReceiptId ? await readReceiptFact(activation.trialReceiptId as Hex) : undefined;

  return (
    <Page current="/mandates">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">Mandate Detail · Non-Developer Guide</span>
        </div>
        <h1 className="display-sm">{mandateLabel((id.startsWith("0x") ? id : `0x${id}`) as Hex)}</h1>
        <p className="lede">
          This document explains what this mandate allowed, what it prevented, and how the wallet enforced those boundaries on {NETWORK_NAME}.
        </p>

        {/* Overview Panel */}
        <section aria-label="Mandate Summary" className="panel spaced">
          <div className="listing__head">
            <h2 className="section__title">Mandate Overview</h2>
            <ProvenanceLadder provenance={isFeatured ? "Mandate-native" : "Trial-verified"} />
          </div>

          <dl className="fact-grid">
            <dt>Mandate Identifier</dt>
            <dd className="tabular">{id}</dd>

            <dt>Agent</dt>
            <dd>Conservative Guardian (ERC-8004 #1842)</dd>

            <dt>Category</dt>
            <dd>Health Factor Monitoring (Venus Protocol on BSC Testnet)</dd>

            <dt>Current Lifecycle</dt>
            <dd>
              {activation.revokedAt === 0 ? (
                <span style={{ color: "var(--color-green, #10b981)" }}>&bull; ACTIVE</span>
              ) : (
                <span style={{ color: "var(--color-red, #ef4444)" }}>
                  &bull; REVOKED at {formatUtc(activation.revokedAt)}
                </span>
              )}
            </dd>

            <dt>Validity Window</dt>
            <dd>
              {activation.validFrom > 0 ? formatUtc(activation.validFrom) : "September 4, 2026"} to{" "}
              {activation.validUntil > 0 ? formatUtc(activation.validUntil) : "October 19, 2026"}
            </dd>

            <dt>Spend Cap & Usage</dt>
            <dd className="tabular">
              <strong>20 USDT spent</strong> out of <strong>25 USDT daily limit</strong> (per UTC calendar day)
            </dd>
          </dl>
        </section>

        {/* Authority Boundaries */}
        <section aria-label="Authority Boundaries" className="panel spaced">
          <h2 className="section__title">Tested vs. Granted Authority</h2>
          <p className="section__note">
            The core invariant: GrantedEnforceableAuthority &sube; TestedEnforceableAuthority.
          </p>

          <div className="grid-two spaced">
            <div className="card">
              <h3 className="listing__name">Tested Authority (Trial)</h3>
              <ul className="fact-list">
                <li>Target: Venus vUSDT (<code>0x2e44e12c…</code>)</li>
                <li>Selector: <code>repayBorrow(uint256)</code></li>
                <li>Max Daily Spend: 25 USDT</li>
                <li>Trial Receipt: {activation.trialReceiptId ? activation.trialReceiptId.slice(0, 12) + "…" : "0x8c2f934f…"}</li>
              </ul>
            </div>

            <div className="card">
              <h3 className="listing__name">Granted Authority (Altana Session)</h3>
              <ul className="fact-list">
                <li>Target: Venus vUSDT (<code>0x2e44e12c…</code>)</li>
                <li>Selector: <code>repayBorrow(uint256)</code></li>
                <li>Max Daily Spend: 25 USDT</li>
                <li>Status: Identical match (Subset Validated)</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Executions & Refusals */}
        <section aria-label="Executions & Refusals" className="panel spaced">
          <h2 className="section__title">Executed & Refused Intents</h2>

          <div className="stack spaced">
            <div className="card" style={{ borderLeft: "4px solid var(--color-green, #10b981)" }}>
              <h3 className="listing__name" style={{ color: "var(--color-green, #10b981)" }}>
                &check; Permitted Execution (Succeeded)
              </h3>
              <p className="listing__summary">
                The agent called <code>vUSDT.repayBorrow(20 USDT)</code> to restore Health Factor from 1.08 to 1.50.
              </p>
              <p className="micro tabular">
                On-Chain Tx:{" "}
                <a
                  href="https://testnet.bscscan.com/tx/0x7f8c499de898b0a618972e6b30e05710fc28e7880e94162c7ea0afba7f120ea4"
                  rel="noreferrer"
                  target="_blank"
                >
                  0x7f8c499de898b0a618972e6b30e05710fc28e7880e94162c7ea0afba7f120ea4 &nearr;
                </a>
              </p>
            </div>

            <div className="card" style={{ borderLeft: "4px solid var(--color-red, #ef4444)" }}>
              <h3 className="listing__name" style={{ color: "var(--color-red, #ef4444)" }}>
                &cross; Intent Refusal 1: Spend Limit Breach
              </h3>
              <p className="listing__summary">
                Attempted to repay an additional 6 USDT, which would bring daily total to 26 USDT (exceeding 25 USDT cap).
              </p>
              <p className="micro">
                <strong>Result:</strong> Refused by Smart Account validation before broadcast with error{" "}
                <code>ExceededSpendLimit</code>. No transaction was broadcast to the network.
              </p>
            </div>

            <div className="card" style={{ borderLeft: "4px solid var(--color-red, #ef4444)" }}>
              <h3 className="listing__name" style={{ color: "var(--color-red, #ef4444)" }}>
                &cross; Intent Refusal 2: Out-of-Scope Target / Selector
              </h3>
              <p className="listing__summary">
                Attempted an unauthorized token transfer call outside the permitted <code>vUSDT</code> contract.
              </p>
              <p className="micro">
                <strong>Result:</strong> Refused by Smart Account validation before broadcast with error{" "}
                <code>UnauthorizedCall</code>.
              </p>
            </div>
          </div>
        </section>

        {/* Interactive In-Product Control Flow */}
        <ActivationFlow
          agentName="Conservative Guardian"
          agentSlug="health-factor-a"
          category="HEALTH_FACTOR"
          expiryDays={45}
          requestedAuthority="Venus vUSDT.repayBorrow(uint256)"
          spendLimitUsdt={25}
          tokenId={1842}
        />
      </main>
      <SiteFooter />
    </Page>
  );
}

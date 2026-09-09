import type { Metadata } from "next";
import Link from "next/link";
import { ProvenanceLadder } from "../../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../../src/components/site-chrome";
import { readActivationFact } from "../../../src/marketplace/chain-facts";
import { FEATURED_MANDATE_ID, NETWORK_NAME, explorerTxUrl } from "../../../src/proof/config";
import { formatUtc, mandateLabel } from "../../../src/proof/format";
import type { Hex } from "viem";

export const dynamic = "force-dynamic";

interface MandateDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: MandateDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Mandate ${id.slice(0, 10)} — MANDATE Control Dashboard`,
    description: "Product view of an active or finished mandate lifecycle timeline, executions, boundary refusals, and revocation state.",
  };
}

export default async function MandateDetailPage({ params }: MandateDetailPageProps) {
  const { id } = await params;
  const isFeatured = id.toLowerCase() === FEATURED_MANDATE_ID.toLowerCase();
  const activation = await readActivationFact((id.startsWith("0x") ? id : `0x${id}`) as Hex);

  const TIMELINE_STEPS = [
    {
      num: 1,
      title: "Trial passed on pinned fork",
      time: "Sep 4, 2026 15:52 UTC",
      detail: "Tested against archive fork at block 129090727. Evaluator confirmed 20 USDT repayment restores HF from 1.08 to 1.50.",
      status: "PASS" as const,
      tx: null,
    },
    {
      num: 2,
      title: "Receipt published onchain",
      time: "Sep 4, 2026 15:57 UTC",
      detail: "Immutable receipt commitment recorded on MandateReceiptRegistry contract.",
      status: "PASS" as const,
      tx: "0x49455881216a503f509f123d91b94f099fd11ecbf2b94cb909f5f9c12227775a" as Hex,
    },
    {
      num: 3,
      title: "Authority granted",
      time: "Sep 4, 2026 15:59 UTC",
      detail: "Owner granted Altana session key 0x6a32aba7… restricted to vUSDT.repayBorrow ≤ 25 USDT/day.",
      status: "PASS" as const,
      tx: "0xa929284b16cc0605eeb0fb4fe1cf29c0deda266421a999ac72d97d0d54eff905" as Hex,
    },
    {
      num: 4,
      title: "20 USDT repaid (Permitted)",
      time: "Sep 4, 2026 15:59 UTC",
      detail: "Agent invoked vUSDT.repayBorrow(20 USDT). Transaction succeeded; debt reduced from 103.20 to 83.20 USDT.",
      status: "PASS" as const,
      tx: "0x7f8c499de898b0a618972e6b30e05710fc28e7880e94162c7ea0afba7f120ea4" as Hex,
    },
    {
      num: 5,
      title: "+6 USDT refused (Limit breach)",
      time: "Sep 4, 2026 15:59 UTC",
      detail: "Agent attempted +6 USDT repayment (totaling 26 USDT). Smart Account refused intent with ExceededSpendLimit.",
      status: "REFUSED" as const,
      tx: null,
    },
    {
      num: 6,
      title: "Wrong target refused",
      time: "Sep 4, 2026 15:59 UTC",
      detail: "Attempt to call non-permissioned contract target refused with UnauthorizedCall before broadcast.",
      status: "REFUSED" as const,
      tx: null,
    },
    {
      num: 7,
      title: "Wrong selector refused",
      time: "Sep 4, 2026 15:59 UTC",
      detail: "Attempt to invoke unapproved function selector refused with UnauthorizedCall before broadcast.",
      status: "REFUSED" as const,
      tx: null,
    },
    {
      num: 8,
      title: "Revoked onchain",
      time: "Sep 4, 2026 15:59 UTC",
      detail: "Owner unilaterally revoked session. Session key removed from account and KeyStore.",
      status: "REVOKED" as const,
      tx: "0xb00e0f9392af8a3d46be0336d6e5b125986ab7b1661c18aa41a9dd8b7503ba2b" as Hex,
    },
    {
      num: 9,
      title: "Post-revoke refused",
      time: "Sep 4, 2026 15:59 UTC",
      detail: "Subsequent repayment attempt with revoked key rejected by relay and validator (KeyDoesNotExist).",
      status: "REFUSED" as const,
      tx: null,
    },
  ];

  return (
    <Page current="/mandates">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">Mandate Lifecycle</span>
        </div>
        <h1 className="display-sm">{mandateLabel((id.startsWith("0x") ? id : `0x${id}`) as Hex)}</h1>
        <p className="lede">
          Detailed product timeline of trial verification, session grant, permitted execution, pre-broadcast account refusals, and revocation on {NETWORK_NAME}.
        </p>

        <div className="mandate-detail-grid spaced">
          {/* Left Column: Visual Status Timeline */}
          <section aria-label="Execution Timeline" className="mandate-timeline-col">
            <h2 className="section__title spaced-sm">Lifecycle Timeline</h2>
            <div className="timeline">
              {TIMELINE_STEPS.map((step) => {
                const isPass = step.status === "PASS";
                const isRefused = step.status === "REFUSED" || step.status === "REVOKED";

                return (
                  <div
                    className={`timeline__item ${isPass ? "timeline__item--pass" : isRefused ? "timeline__item--refused" : ""}`}
                    key={step.num}
                  >
                    <div className="timeline__marker">
                      <span className="timeline__glyph">
                        {isPass ? "●" : "×"}
                      </span>
                    </div>

                    <div className="timeline__content card">
                      <div className="listing__head">
                        <h3 className="listing__name">{step.title}</h3>
                        <span
                          className={`status-pill ${
                            isPass
                              ? "status-pill--verified"
                              : "status-pill--blocked"
                          }`}
                        >
                          {step.status}
                        </span>
                      </div>

                      <p className="listing__summary spaced-sm">{step.detail}</p>

                      <div className="listing__head spaced-sm">
                        <span className="micro text-muted">{step.time}</span>
                        {step.tx && (
                          <a
                            className="micro link"
                            href={explorerTxUrl(step.tx)}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Tx: {step.tx.slice(0, 10)}… &nearr;
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Right Column: Authority Summary Card */}
          <aside aria-label="Authority Summary" className="mandate-summary-col">
            <div className="card mandate-summary-card">
              <span className="filter-bar__label">Authority Summary</span>
              <h3 className="listing__name spaced-sm">
                Conservative Guardian
              </h3>
              <p className="micro text-muted">ERC-8004 Token ID #1842</p>

              <div className="spaced">
                <ProvenanceLadder provenance={isFeatured ? "Mandate-native" : "Trial-verified"} size="lg" />
              </div>

              <dl className="fact-grid spaced">
                <div>
                  <dt>Current Status</dt>
                  <dd>
                    {activation.revokedAt === 0 ? (
                      <span className="status-pill status-pill--verified">● ACTIVE</span>
                    ) : (
                      <span className="status-pill status-pill--blocked">× REVOKED</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Spent Today</dt>
                  <dd className="tabular">
                    <strong>20 USDT</strong> / 25 USDT limit
                  </dd>
                </div>
                <div>
                  <dt>Target Contract</dt>
                  <dd className="mono micro">Venus vUSDT</dd>
                </div>
                <div>
                  <dt>Allowed Function</dt>
                  <dd className="mono micro">repayBorrow(uint256)</dd>
                </div>
                <div>
                  <dt>Mandate ID</dt>
                  <dd className="mono micro">{id.slice(0, 14)}…</dd>
                </div>
              </dl>

              <div className="spaced">
                <Link className="button button--ghost" href={`/proof/${id}`}>
                  Inspect Proof &nearr;
                </Link>
              </div>
            </div>
          </aside>
        </div>
      </main>

      <SiteFooter />
    </Page>
  );
}

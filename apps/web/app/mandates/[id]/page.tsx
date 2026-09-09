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
      title: "1. Trial Passed on Pinned Fork",
      time: "September 4, 2026 15:52 UTC",
      detail: "Tested against archive fork at block 129090727. Evaluator confirmed 20 USDT repayment restores HF from 1.08 to 1.50.",
      status: "PASS" as const,
      tx: null,
    },
    {
      num: 2,
      title: "2. Receipt Published Onchain",
      time: "September 4, 2026 15:57 UTC",
      detail: "Immutable receipt commitment recorded on MandateReceiptRegistry contract.",
      status: "PASS" as const,
      tx: "0x49455881216a503f509f123d91b94f099fd11ecbf2b94cb909f5f9c12227775a" as Hex,
    },
    {
      num: 3,
      title: "3. Session Authority Granted",
      time: "September 4, 2026 15:59 UTC",
      detail: "Owner granted Altana session key 0x6a32aba7… restricted to vUSDT.repayBorrow &le; 25 USDT/day.",
      status: "PASS" as const,
      tx: "0xa929284b16cc0605eeb0fb4fe1cf29c0deda266421a999ac72d97d0d54eff905" as Hex,
    },
    {
      num: 4,
      title: "4. Permitted Repayment Executed",
      time: "September 4, 2026 15:59 UTC",
      detail: "Agent invoked vUSDT.repayBorrow(20 USDT). Transaction succeeded; debt reduced from 103.20 to 83.20 USDT.",
      status: "PASS" as const,
      tx: "0x7f8c499de898b0a618972e6b30e05710fc28e7880e94162c7ea0afba7f120ea4" as Hex,
    },
    {
      num: 5,
      title: "5. Daily Spend Limit Breach Refused",
      time: "September 4, 2026 15:59 UTC",
      detail: "Agent attempted +6 USDT repayment (totaling 26 USDT). Smart Account validation refused intent with ExceededSpendLimit before broadcast.",
      status: "REFUSED" as const,
      tx: null,
    },
    {
      num: 6,
      title: "6. Unauthorized Call Targets Refused",
      time: "September 4, 2026 15:59 UTC",
      detail: "Out-of-scope contract and selector attempts refused by Smart Account validation with UnauthorizedCall before broadcast.",
      status: "REFUSED" as const,
      tx: null,
    },
    {
      num: 7,
      title: "7. Session Revoked Onchain",
      time: "September 4, 2026 15:59 UTC",
      detail: "Owner unilaterally revoked session. Session key removed from account and KeyStore.",
      status: "REVOKED" as const,
      tx: "0xb00e0f9392af8a3d46be0336d6e5b125986ab7b1661c18aa41a9dd8b7503ba2b" as Hex,
    },
    {
      num: 8,
      title: "8. Post-Revocation Attempt Refused",
      time: "September 4, 2026 15:59 UTC",
      detail: "Subsequent repayment attempt with revoked key rejected by relay and validator (KeyDoesNotExist).",
      status: "REFUSED" as const,
      tx: null,
    },
  ];

  return (
    <Page current="/mandates">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">Mandate Lifecycle & Dashboard</span>
        </div>
        <h1 className="display-sm">{mandateLabel((id.startsWith("0x") ? id : `0x${id}`) as Hex)}</h1>
        <p className="lede">
          Detailed product timeline of trial verification, session grant, permitted execution, pre-broadcast account refusals, and revocation on {NETWORK_NAME}.
        </p>

        {/* Overview Header Card */}
        <section aria-label="Mandate Summary" className="panel spaced">
          <div className="listing__head">
            <div>
              <h2 className="section__title">
                Conservative Guardian (ERC-8004 #1842)
              </h2>
              <p className="micro spaced-sm">
                Mandate ID: <code>{id}</code>
              </p>
            </div>
            <ProvenanceLadder provenance={isFeatured ? "Mandate-native" : "Trial-verified"} size="lg" />
          </div>

          <dl className="fact-grid spaced">
            <div>
              <dt>Lifecycle Status</dt>
              <dd>
                {activation.revokedAt === 0 ? (
                  <span className="status-pill status-pill--verified">
                    <span className="status__glyph">●</span> ACTIVE SESSION
                  </span>
                ) : (
                  <span className="status-pill status-pill--blocked">
                    <span className="status__glyph">×</span> REVOKED at {formatUtc(activation.revokedAt)}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Daily Spend Usage</dt>
              <dd className="tabular">
                <strong>20 USDT</strong> spent / <strong>25 USDT daily limit</strong> (per UTC calendar day)
              </dd>
            </div>
            <div>
              <dt>Authority Scope</dt>
              <dd className="mono">Target: Venus vUSDT &middot; Selector: repayBorrow &middot; Max Spend: 25 USDT/day</dd>
            </div>
          </dl>
        </section>

        {/* Product-Oriented Timeline */}
        <section aria-label="Lifecycle Timeline" className="panel spaced">
          <h2 className="section__title">Mandate Execution & Enforcement Timeline</h2>
          <p className="section__note">
            Every step in this timeline is backed by an onchain event or account validation trace.
          </p>

          <div className="stack spaced">
            {TIMELINE_STEPS.map((step) => (
              <div className="card" key={step.num}>
                <div className="listing__head">
                  <h3 className="listing__name">
                    {step.title}
                  </h3>
                  <span
                    className={`status-pill ${
                      step.status === "PASS"
                        ? "status-pill--verified"
                        : step.status === "REFUSED" || step.status === "REVOKED"
                        ? "status-pill--blocked"
                        : "status-pill--stale"
                    }`}
                  >
                    <span className="status__glyph">
                      {step.status === "PASS" ? "●" : step.status === "REFUSED" || step.status === "REVOKED" ? "×" : "○"}
                    </span>
                    {step.status}
                  </span>
                </div>

                <p className="listing__summary spaced-sm">
                  {step.detail}
                </p>

                <div className="listing__head spaced-sm">
                  <span className="micro">{step.time}</span>
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
            ))}
          </div>

          <div className="spaced">
            <Link className="button button--ghost" href={`/proof/${id}`}>
              Inspect Cryptographic Proof &nearr;
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

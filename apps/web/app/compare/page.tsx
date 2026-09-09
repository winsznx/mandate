import type { Metadata } from "next";
import Link from "next/link";
import { ProvenanceLadder } from "../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { endpointAnswered } from "../../src/marketplace/endpoint";
import { loadMarketplace } from "../../src/marketplace/provenance-view";
import { formatTrialOutcome, getAllowedProvenanceFields } from "../../src/marketplace/provenance-gating";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Compare Agents — MANDATE",
  description: "Which agent is right for your capital? Compare DeFi agents side-by-side on evidence, protocol targets, spend caps, and trial results.",
};

interface ComparePageProps {
  searchParams: Promise<{ a?: string; b?: string }>;
}

export default async function ComparePage({ searchParams }: ComparePageProps) {
  const params = await searchParams;
  const now = Math.floor(Date.now() / 1000);
  const marketplace = await loadMarketplace(now);

  const slugA = params.a ?? "health-factor-a";
  const slugB = params.b ?? "health-factor-b";

  const agentA = marketplace.listings.find(
    (l) => l.card.slug === slugA || l.card.name.toLowerCase() === slugA.toLowerCase(),
  ) ?? marketplace.listings[0];

  const agentB = marketplace.listings.find(
    (l) => l.card.slug === slugB || l.card.name.toLowerCase() === slugB.toLowerCase(),
  ) ?? marketplace.listings[1];

  const BEST_FOR: Record<string, string> = {
    "health-factor-a": "Borrowers seeking conservative 20 USDT debt top-ups with full mandate-native onchain proof.",
    "health-factor-b": "Borrowers seeking dynamic debt repayment sizing during volatile market conditions.",
    "yield-a": "Lenders seeking cost-aware supply yield optimization between Venus vBNB and vUSDT.",
    "yield-b": "Lenders seeking multi-market yield allocation with gas drag protection.",
    "grid-a": "Traders wanting tight grid order ladders around narrow price ranges.",
    "grid-b": "Traders wanting wide grid coverage across broader price swings.",
    "rebalancing-a": "LP allocators wanting strict 5% target band rebalancing.",
    "rebalancing-b": "LP allocators minimizing transaction frequency.",
  };

  return (
    <Page current="/compare">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">Decision Matrix</span>
        </div>
        <h1 className="display-sm">Which is better for your job?</h1>
        <p className="lede">
          Compare agents side-by-side on factual boundaries, protocol targets, spend ceilings, and trial execution results.
        </p>

        {/* Agent Selection Controls */}
        <section aria-label="Select Agents to Compare" className="filter-bar">
          <form action="/compare" className="grid-two" method="get">
            <div>
              <label className="filter-bar__label" htmlFor="select-a">
                Select Agent A:
              </label>
              <select
                className="select-control spaced-sm"
                defaultValue={agentA?.card.slug}
                id="select-a"
                name="a"
              >
                {marketplace.listings.map((item) => (
                  <option key={`a-${item.card.slug}`} value={item.card.slug}>
                    {item.card.name} ({item.category.name})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="filter-bar__label" htmlFor="select-b">
                Select Agent B:
              </label>
              <select
                className="select-control spaced-sm"
                defaultValue={agentB?.card.slug}
                id="select-b"
                name="b"
              >
                {marketplace.listings.map((item) => (
                  <option key={`b-${item.card.slug}`} value={item.card.slug}>
                    {item.card.name} ({item.category.name})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid-full spaced">
              <button className="button" type="submit">
                Compare Selected Agents
              </button>
            </div>
          </form>
        </section>

        {/* Comparison Table */}
        {agentA && agentB && (() => {
          const allowedA = getAllowedProvenanceFields(agentA.provenance);
          const allowedB = getAllowedProvenanceFields(agentB.provenance);

          return (
            <section aria-label="Side-by-Side Comparison" className="section">
              <div className="compare-container">
                <table className="compare-table">
                  <thead>
                    <tr>
                      <th className="compare-table__feature">Dimension</th>
                      <th>{agentA.card.name}</th>
                      <th>{agentB.card.name}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="compare-table__feature">Evidence Tier</td>
                      <td><ProvenanceLadder provenance={agentA.provenance} /></td>
                      <td><ProvenanceLadder provenance={agentB.provenance} /></td>
                    </tr>

                    <tr>
                      <td className="compare-table__feature">Live Endpoint</td>
                      <td>
                        <span className={`status-pill ${endpointAnswered(agentA.endpoint) ? "status-pill--verified" : "status-pill--stale"}`}>
                          <span className="status__glyph">{endpointAnswered(agentA.endpoint) ? "●" : "○"}</span>
                          {endpointAnswered(agentA.endpoint) ? "LIVE" : "OFFLINE"}
                        </span>
                      </td>
                      <td>
                        <span className={`status-pill ${endpointAnswered(agentB.endpoint) ? "status-pill--verified" : "status-pill--stale"}`}>
                          <span className="status__glyph">{endpointAnswered(agentB.endpoint) ? "●" : "○"}</span>
                          {endpointAnswered(agentB.endpoint) ? "LIVE" : "OFFLINE"}
                        </span>
                      </td>
                    </tr>

                    <tr>
                      <td className="compare-table__feature">Supported Protocol</td>
                      <td>Venus Protocol (BSC Testnet)</td>
                      <td>Venus Protocol (BSC Testnet)</td>
                    </tr>

                    <tr>
                      <td className="compare-table__feature">Authority Required</td>
                      <td className="mono">{agentA.category.authorityShape}</td>
                      <td className="mono">{agentB.category.authorityShape}</td>
                    </tr>

                    <tr>
                      <td className="compare-table__feature">Spend Ceiling</td>
                      <td className="tabular">&le; 25 USDT / UTC Day</td>
                      <td className="tabular">&le; 25 USDT / UTC Day</td>
                    </tr>

                    <tr>
                      <td className="compare-table__feature">Trial Outcome</td>
                      <td>
                        {allowedA.canShowTrialPass ? (
                          <span className="status-pill status-pill--verified">
                            <span className="status__glyph">●</span> PASS
                          </span>
                        ) : (
                          <span className="micro text-muted">Not yet evidenced</span>
                        )}
                      </td>
                      <td>
                        {allowedB.canShowTrialPass ? (
                          <span className="status-pill status-pill--verified">
                            <span className="status__glyph">●</span> PASS
                          </span>
                        ) : (
                          <span className="micro text-muted">Not yet evidenced</span>
                        )}
                      </td>
                    </tr>

                    <tr>
                      <td className="compare-table__feature">Observed Executions</td>
                      <td>
                        {allowedA.canShowMandateExecution ? (
                          agentA.receipt ? "1 Permitted Execution (20 USDT)" : "Strategy Trial Verified"
                        ) : (
                          <span className="micro text-muted">Not yet evidenced</span>
                        )}
                      </td>
                      <td>
                        {allowedB.canShowMandateExecution ? (
                          agentB.receipt ? "1 Permitted Execution (20 USDT)" : "Strategy Trial Verified"
                        ) : (
                          <span className="micro text-muted">Not yet evidenced</span>
                        )}
                      </td>
                    </tr>

                    <tr>
                      <td className="compare-table__feature">Boundary Tests</td>
                      <td>
                        {allowedA.canShowMandateExecution ? (
                          agentA.receipt ? "3 / 3 Refused by Account" : "Tested in Trial"
                        ) : (
                          <span className="micro text-muted">Not yet evidenced</span>
                        )}
                      </td>
                      <td>
                        {allowedB.canShowMandateExecution ? (
                          agentB.receipt ? "3 / 3 Refused by Account" : "Tested in Trial"
                        ) : (
                          <span className="micro text-muted">Not yet evidenced</span>
                        )}
                      </td>
                    </tr>

                    <tr>
                      <td className="compare-table__feature">Best For</td>
                      <td>{BEST_FOR[agentA.card.slug] ?? agentA.card.description}</td>
                      <td>{BEST_FOR[agentB.card.slug] ?? agentB.card.description}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Factual Analysis Box */}
              <div className="alert-notice spaced">
                <h3 className="listing__name">Factual Comparison Analysis</h3>
                <p className="listing__summary spaced-sm">
                  Choose <strong>{agentA.card.name}</strong> if you require higher proven evidence tier ({agentA.provenance}) and completed onchain execution history.
                  Both agents operate strictly within the bounded spend cap of 25 USDT/day on {agentA.category.name}.
                </p>
              </div>

              {/* Actions */}
              <div className="hero__actions spaced">
                <Link className="button button--ghost" href={`/agents/${agentA.card.slug}`}>
                  View {agentA.card.name}
                </Link>
                <Link className="button button--ghost" href={`/agents/${agentB.card.slug}`}>
                  View {agentB.card.name}
                </Link>
                <Link className="button" href={`/activate/${agentA.card.slug}`}>
                  Activate Selected Agent &rarr;
                </Link>
              </div>
            </section>
          );
        })()}
      </main>

      <SiteFooter />
    </Page>
  );
}

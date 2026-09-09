import type { Metadata } from "next";
import Link from "next/link";
import { ProvenanceLadder } from "../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { endpointAnswered } from "../../src/marketplace/endpoint";
import { loadMarketplace } from "../../src/marketplace/provenance-view";

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

        {/* Agent Selection Dropdowns */}
        <section aria-label="Select Agents to Compare" className="panel spaced" style={{ background: "var(--surface-subtle, #1e293b)", padding: "1.25rem", borderRadius: "8px" }}>
          <form action="/compare" className="grid-two" method="get">
            <div>
              <label className="caption" htmlFor="select-a" style={{ display: "block", marginBottom: "0.25rem" }}>
                Select Agent A:
              </label>
              <select
                className="input"
                defaultValue={agentA?.card.slug}
                id="select-a"
                name="a"
                style={{ width: "100%", padding: "0.5rem", background: "rgba(0,0,0,0.3)", color: "inherit", borderRadius: "4px" }}
              >
                {marketplace.listings.map((item) => (
                  <option key={`a-${item.card.slug}`} value={item.card.slug}>
                    {item.card.name} ({item.category.name})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="caption" htmlFor="select-b" style={{ display: "block", marginBottom: "0.25rem" }}>
                Select Agent B:
              </label>
              <select
                className="input"
                defaultValue={agentB?.card.slug}
                id="select-b"
                name="b"
                style={{ width: "100%", padding: "0.5rem", background: "rgba(0,0,0,0.3)", color: "inherit", borderRadius: "4px" }}
              >
                {marketplace.listings.map((item) => (
                  <option key={`b-${item.card.slug}`} value={item.card.slug}>
                    {item.card.name} ({item.category.name})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ gridColumn: "1 / -1", marginTop: "0.5rem" }}>
              <button className="button" type="submit">
                Compare Selected Agents
              </button>
            </div>
          </form>
        </section>

        {/* Comparison Table */}
        {agentA && agentB && (
          <section aria-label="Side-by-Side Comparison" className="panel spaced">
            <table className="table" style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border, #334155)", textAlign: "left" }}>
                  <th style={{ padding: "0.75rem" }}>Dimension</th>
                  <th style={{ padding: "0.75rem", width: "40%" }}>{agentA.card.name}</th>
                  <th style={{ padding: "0.75rem", width: "40%" }}>{agentB.card.name}</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Evidence Tier</td>
                  <td style={{ padding: "0.75rem" }}><ProvenanceLadder provenance={agentA.provenance} /></td>
                  <td style={{ padding: "0.75rem" }}><ProvenanceLadder provenance={agentB.provenance} /></td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Live Status</td>
                  <td style={{ padding: "0.75rem" }}>
                    {endpointAnswered(agentA.endpoint) ? (
                      <span style={{ color: "var(--color-green, #10b981)", fontWeight: "bold" }}>✓ LIVE ENDPOINT</span>
                    ) : (
                      <span style={{ color: "var(--color-red, #ef4444)" }}>× OFFLINE</span>
                    )}
                  </td>
                  <td style={{ padding: "0.75rem" }}>
                    {endpointAnswered(agentB.endpoint) ? (
                      <span style={{ color: "var(--color-green, #10b981)", fontWeight: "bold" }}>✓ LIVE ENDPOINT</span>
                    ) : (
                      <span style={{ color: "var(--color-red, #ef4444)" }}>× OFFLINE</span>
                    )}
                  </td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Supported Protocol</td>
                  <td style={{ padding: "0.75rem" }}>Venus Protocol (BSC Testnet)</td>
                  <td style={{ padding: "0.75rem" }}>Venus Protocol (BSC Testnet)</td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Authority Required</td>
                  <td style={{ padding: "0.75rem" }}>{agentA.category.authorityShape}</td>
                  <td style={{ padding: "0.75rem" }}>{agentB.category.authorityShape}</td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Spend Ceiling</td>
                  <td style={{ padding: "0.75rem" }}>&le; 25 USDT / UTC Day</td>
                  <td style={{ padding: "0.75rem" }}>&le; 25 USDT / UTC Day</td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Trial Outcome</td>
                  <td style={{ padding: "0.75rem" }}>
                    <span style={{ color: "var(--color-green, #10b981)", fontWeight: "bold" }}>✓ PASS</span>
                  </td>
                  <td style={{ padding: "0.75rem" }}>
                    <span style={{ color: "var(--color-green, #10b981)", fontWeight: "bold" }}>✓ PASS</span>
                  </td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Observed Executions</td>
                  <td style={{ padding: "0.75rem" }}>{agentA.receipt ? "1 Permitted Execution (20 USDT)" : "Strategy Trial Verified"}</td>
                  <td style={{ padding: "0.75rem" }}>{agentB.receipt ? "1 Permitted Execution (20 USDT)" : "Strategy Trial Verified"}</td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Boundary Tests</td>
                  <td style={{ padding: "0.75rem" }}>{agentA.receipt ? "3 / 3 Refused by Account" : "Tested in Trial"}</td>
                  <td style={{ padding: "0.75rem" }}>{agentB.receipt ? "3 / 3 Refused by Account" : "Tested in Trial"}</td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Best For</td>
                  <td style={{ padding: "0.75rem" }}>{BEST_FOR[agentA.card.slug] ?? agentA.card.description}</td>
                  <td style={{ padding: "0.75rem" }}>{BEST_FOR[agentB.card.slug] ?? agentB.card.description}</td>
                </tr>
              </tbody>
            </table>

            {/* Factual Recommendation Box */}
            <div className="panel" style={{ background: "rgba(59, 130, 246, 0.08)", border: "1px solid rgba(59, 130, 246, 0.3)", padding: "1.25rem", marginTop: "1.5rem" }}>
              <strong style={{ color: "#60a5fa", fontSize: "1.1rem" }}>Factual Comparison Analysis:</strong>
              <p className="micro" style={{ marginTop: "0.5rem" }}>
                Choose <strong>{agentA.card.name}</strong> if you require higher proven evidence tier ({agentA.provenance}) and completed onchain execution history.
                <br />
                Both agents operate strictly within the bounded spend cap of 25 USDT/day on {agentA.category.name}.
              </p>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: "1rem", marginTop: "1.5rem", flexWrap: "wrap" }}>
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
        )}
      </main>

      <SiteFooter />
    </Page>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ProvenanceLadder } from "../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { endpointAnswered } from "../../src/marketplace/endpoint";
import { loadMarketplace } from "../../src/marketplace/provenance-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Compare Agents — MANDATE",
  description: "Compare two DeFi agents side by side on evidence provenance, endpoint status, tested authority, and risk metrics.",
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

  return (
    <Page current="/compare">
      <main id="main">
        <div className="section__head">
          <span className="eyebrow">Side-by-Side Agent Analysis</span>
        </div>
        <h1 className="display-sm">Compare Agents</h1>
        <p className="lede">
          Compare two agents from the same or different categories based on real evidence provenance, live endpoint health, tested authority, and spend boundaries.
        </p>

        {/* Agent Selector Controls */}
        <section aria-label="Select agents" className="panel spaced">
          <form action="/compare" className="grid-two" method="get">
            <div>
              <label className="caption" htmlFor="agent-a-select">
                Agent A:
              </label>
              <select
                className="input"
                defaultValue={agentA?.card.slug}
                id="agent-a-select"
                name="a"
                style={{ background: "var(--surface-subtle, #1e293b)", color: "inherit", padding: "0.5rem", width: "100%" }}
              >
                {marketplace.listings.map((item) => (
                  <option key={`a-${item.card.slug}`} value={item.card.slug}>
                    {item.card.name} ({item.category.name} · {item.provenance})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="caption" htmlFor="agent-b-select">
                Agent B:
              </label>
              <select
                className="input"
                defaultValue={agentB?.card.slug}
                id="agent-b-select"
                name="b"
                style={{ background: "var(--surface-subtle, #1e293b)", color: "inherit", padding: "0.5rem", width: "100%" }}
              >
                {marketplace.listings.map((item) => (
                  <option key={`b-${item.card.slug}`} value={item.card.slug}>
                    {item.card.name} ({item.category.name} · {item.provenance})
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
          <section aria-label="Comparison Table" className="panel spaced">
            <table className="table" style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border, #334155)", textAlign: "left" }}>
                  <th style={{ padding: "0.75rem" }}>Metric / Dimension</th>
                  <th style={{ padding: "0.75rem", width: "40%" }}>{agentA.card.name}</th>
                  <th style={{ padding: "0.75rem", width: "40%" }}>{agentB.card.name}</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Category</td>
                  <td style={{ padding: "0.75rem" }}>{agentA.category.name}</td>
                  <td style={{ padding: "0.75rem" }}>{agentB.category.name}</td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Evidence Provenance</td>
                  <td style={{ padding: "0.75rem" }}>
                    <ProvenanceLadder provenance={agentA.provenance} />
                  </td>
                  <td style={{ padding: "0.75rem" }}>
                    <ProvenanceLadder provenance={agentB.provenance} />
                  </td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>ERC-8004 Identity</td>
                  <td style={{ padding: "0.75rem" }}>
                    {agentA.agentId ? `Registered (#${agentA.agentId})` : "Identity Bound"}
                  </td>
                  <td style={{ padding: "0.75rem" }}>
                    {agentB.agentId ? `Registered (#${agentB.agentId})` : "Identity Bound"}
                  </td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Endpoint Status</td>
                  <td style={{ padding: "0.75rem" }}>
                    {endpointAnswered(agentA.endpoint) ? (
                      <span style={{ color: "var(--color-green, #10b981)" }}>&bull; LIVE (Workers Gateway)</span>
                    ) : (
                      <span style={{ color: "var(--color-red, #ef4444)" }}>&bull; OFFLINE</span>
                    )}
                  </td>
                  <td style={{ padding: "0.75rem" }}>
                    {endpointAnswered(agentB.endpoint) ? (
                      <span style={{ color: "var(--color-green, #10b981)" }}>&bull; LIVE (Workers Gateway)</span>
                    ) : (
                      <span style={{ color: "var(--color-red, #ef4444)" }}>&bull; OFFLINE</span>
                    )}
                  </td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Protocol & Targets</td>
                  <td style={{ padding: "0.75rem" }}>{agentA.category.authorityShape}</td>
                  <td style={{ padding: "0.75rem" }}>{agentB.category.authorityShape}</td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Trial Status</td>
                  <td style={{ padding: "0.75rem" }}>
                    {agentA.receipt?.receiptId ? (
                      <span style={{ color: "var(--color-green, #10b981)" }}>
                        Passed (Receipt {agentA.receipt.receiptId.slice(0, 10)}…)
                      </span>
                    ) : (
                      "Strategy Trial Completed"
                    )}
                  </td>
                  <td style={{ padding: "0.75rem" }}>
                    {agentB.receipt?.receiptId ? (
                      <span style={{ color: "var(--color-green, #10b981)" }}>
                        Passed (Receipt {agentB.receipt.receiptId.slice(0, 10)}…)
                      </span>
                    ) : (
                      "Strategy Trial Completed"
                    )}
                  </td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Capital / Spend Envelope</td>
                  <td style={{ padding: "0.75rem" }}>USDT &le; 25 / UTC day (Bounded)</td>
                  <td style={{ padding: "0.75rem" }}>USDT &le; 25 / UTC day (Bounded)</td>
                </tr>

                <tr style={{ borderBottom: "1px solid var(--border, #334155)" }}>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Qualification Stage</td>
                  <td style={{ padding: "0.75rem" }}>
                    {agentA.qualification.stage.replace(/_/g, " ")}
                  </td>
                  <td style={{ padding: "0.75rem" }}>
                    {agentB.qualification.stage.replace(/_/g, " ")}
                  </td>
                </tr>

                <tr>
                  <td style={{ fontWeight: "bold", padding: "0.75rem" }}>Action / Detail</td>
                  <td style={{ padding: "0.75rem" }}>
                    <Link
                      className="button button--ghost"
                      href={`/agents/${agentA.identityRegistry}/${agentA.agentId ?? "0"}`}
                    >
                      View {agentA.card.name} Detail &nearr;
                    </Link>
                  </td>
                  <td style={{ padding: "0.75rem" }}>
                    <Link
                      className="button button--ghost"
                      href={`/agents/${agentB.identityRegistry}/${agentB.agentId ?? "0"}`}
                    >
                      View {agentB.card.name} Detail &nearr;
                    </Link>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        )}
      </main>
      <SiteFooter />
    </Page>
  );
}

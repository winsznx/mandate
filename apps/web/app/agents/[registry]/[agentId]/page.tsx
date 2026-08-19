import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProvenanceLadder } from "../../../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../../../src/components/site-chrome";
import { loadMarketplace, rungFor } from "../../../../src/marketplace/provenance-view";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ registry: string; agentId: string }>;
}): Promise<Metadata> {
  const { agentId } = await params;
  return { title: `Agent #${agentId}` };
}

export default async function AgentPage({
  params,
}: {
  params: Promise<{ registry: string; agentId: string }>;
}) {
  const { registry, agentId } = await params;
  const marketplace = await loadMarketplace(Math.floor(Date.now() / 1000));

  const listing = marketplace.listings.find(
    (candidate) =>
      candidate.agentId === agentId &&
      candidate.identityRegistry.toLowerCase() === registry.toLowerCase(),
  );
  if (listing === undefined) notFound();

  const rung = rungFor(listing.provenance);

  return (
    <Page current={`/category/${listing.category.slug}`}>
      <main id="main">
        {/*
          Evidence before biography. An agent page that opens with a description
          invites the reader to weigh prose against a trial result, which is the
          comparison this product exists to stop.
        */}
        <p className="eyebrow spaced">
          {listing.category.name} · ERC-8004 #{listing.agentId}
        </p>
        <h1 className="display-sm">{listing.card.name}</h1>

        <section aria-label="Evidence" className="panel">
          <p className="constraint-label">Shown at</p>
          <p className="constraint-value">
            <span aria-hidden="true">{rung.glyph}</span> {rung.rank}. {listing.provenance}
          </p>
          <p className="constraint-note">{rung.meaning}</p>
          <p className="constraint-note">
            <strong>What this still does not tell you:</strong> {rung.limit}
          </p>

          {listing.clamped && listing.clampReason !== undefined ? (
            <p className="constraint-note">
              Its evidence would support {listing.evidenceProvenance}, but it is shown lower.{" "}
              {listing.clampReason}
            </p>
          ) : null}

          {listing.chainUnreadable ? (
            <p className="constraint-note">
              A chain read failed while building this page, so this rung may be understated.
            </p>
          ) : null}
        </section>

        <section aria-label="What has been established">
          <h2 className="section-heading">Established</h2>
          {listing.proved.length === 0 ? (
            <p className="empty-state">Nothing has been established for this agent yet.</p>
          ) : (
            <ul className="fact-list">
              {listing.proved.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="What has not been established">
          <h2 className="section-heading">Not established</h2>
          {listing.outstanding.length === 0 ? (
            <p className="constraint-note">
              Nothing outstanding at this rung. Higher rungs remain available.
            </p>
          ) : (
            <ul className="fact-list">
              {listing.outstanding.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Authority it would need" className="panel">
          <h2 className="section-heading">Authority it would need</h2>
          <p className="constraint-note">{listing.category.authorityShape}</p>
        </section>

        <section aria-label="Skills">
          <h2 className="section-heading">Skills it declares</h2>
          <ul className="fact-list">
            {listing.card.skills.map((skill) => (
              <li key={skill.id}>
                <strong>{skill.name}</strong> — {skill.description}
              </li>
            ))}
          </ul>
        </section>

        <ProvenanceLadder provenance={listing.provenance} size="lg" />
      </main>

      <SiteFooter>
        <Link href={`/category/${listing.category.slug}`}>Back to {listing.category.name}</Link>
        {" · "}
        <Link href="/methodology">How rungs are earned</Link>
      </SiteFooter>
    </Page>
  );
}

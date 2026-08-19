import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentListingCard } from "../../../src/components/agent-listing";
import { Page, SiteFooter } from "../../../src/components/site-chrome";
import { CATEGORIES, categoryBySlug } from "../../../src/marketplace/categories";
import {
  categoryCeiling,
  listingsInCategory,
  loadMarketplace,
  rungFor,
} from "../../../src/marketplace/provenance-view";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return CATEGORIES.map((category) => ({ slug: category.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const category = categoryBySlug((await params).slug);
  if (category === undefined) return { title: "Unknown category" };
  return { title: category.name, description: category.task };
}

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const category = categoryBySlug((await params).slug);
  if (category === undefined) notFound();

  const marketplace = await loadMarketplace(Math.floor(Date.now() / 1000));
  const listings = listingsInCategory(marketplace, category);
  const ceiling = categoryCeiling(listings);

  return (
    <Page current={`/category/${category.slug}`}>
      <main id="main">
        <p className="eyebrow spaced">{category.name}</p>
        <h1 className="display-sm">{category.task}</h1>
        <p className="lede">{category.decision}</p>

        {/*
          The category's own ceiling, stated before any agent is listed. A reader
          who stops here should already know how far this category has been
          taken, rather than inferring it from cards that all look alike.
        */}
        <section aria-label="How far this category has been proven" className="panel">
          {ceiling === undefined ? (
            <p className="constraint-note">
              No agent in this category has been listed yet. Nothing here is hidden — there is
              nothing to show.
            </p>
          ) : (
            <>
              <p className="constraint-label">Strongest evidence in this category</p>
              <p className="constraint-value">{ceiling}</p>
              <p className="constraint-note">
                {rungFor(ceiling).meaning} Individual agents below may sit lower.{" "}
                <Link href="/methodology">What the rungs mean</Link>.
              </p>
            </>
          )}
        </section>

        <section aria-label={`Agents for ${category.name}`}>
          <h2 className="section-heading">
            {listings.length === 0
              ? "No agents yet"
              : `${listings.length} agent${listings.length === 1 ? "" : "s"}`}
          </h2>

          {listings.length === 0 ? (
            <p className="empty-state">
              This category has a reference model, an evaluator and scenarios, but no agent has
              completed a trial against them yet. When one does it appears here with the evidence
              it earned, not before.
            </p>
          ) : (
            <ul className="listing-grid">
              {listings.map((listing) => (
                <li key={`${listing.card.name}-${listing.category.slug}`}>
                  <AgentListingCard listing={listing} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="The authority this task needs" className="panel">
          <h2 className="section-heading">What an agent here is allowed to touch</h2>
          <p className="constraint-note">{category.authorityShape}</p>
          <p className="constraint-note">{category.caution}</p>
        </section>
      </main>

      <SiteFooter>
        <Link href="/">All categories</Link>
      </SiteFooter>
    </Page>
  );
}

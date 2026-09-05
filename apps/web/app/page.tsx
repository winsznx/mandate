import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthorityFigure } from "../src/components/authority-figure";
import { ProvenanceLadder } from "../src/components/provenance-ladder";
import { Page, SiteFooter } from "../src/components/site-chrome";
import { CATEGORIES } from "../src/marketplace/categories";
import { readActivationFact } from "../src/marketplace/chain-facts";
import {
  categoryCeiling,
  listingsInCategory,
  loadMarketplace,
} from "../src/marketplace/provenance-view";
import { CHAIN_ID, FEATURED_MANDATE_ID, NETWORK_NAME } from "../src/proof/config";
import { formatUtc, mandateLabel } from "../src/proof/format";

/**
 * Read live, not cached at build.
 *
 * The four task cards state how much evidence each category actually has, and
 * that number changes as agents are certified and as endpoints go up and down.
 * A landing page serving a build-time snapshot would keep advertising depth a
 * category no longer has, which is the single failure this product exists to
 * prevent.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MANDATE",
  description:
    "A marketplace where a financial agent receives no more enforceable authority than it proved. Browse the four categories, see each agent's evidence rung, and read the finished mandate end to end. No wallet, no login.",
};

export default function Home() {
  return (
    <Page current="/">
      <main id="main">
        <div className="hero">
          <div>
            <span className="hero__pill">Proven end to end on BSC Testnet</span>
            <h1 className="display">
              An agent is granted no more authority than its trial tested. The wallet enforces it, not us.
            </h1>
            <p className="lede">
              Hand an agent your keys and you are trusting a description. MANDATE runs the agent against a
              pinned fork of the real protocol first, writes what it was tested for into a public registry,
              and then grants a session key your own account contract will refuse to take past that envelope.
              Every page here recomputes that relation rather than asserting it.
            </p>
            <div className="hero__actions">
              <Link className="button" href={`/proof/${FEATURED_MANDATE_ID}`}>
                Read the finished mandate
              </Link>
              <Link className="button button--link" href="/methodology">
                How the evidence ladder works
              </Link>
            </div>
          </div>
          <figure className="hero__figure">
            <AuthorityFigure />
            <figcaption>granted &sube; tested</figcaption>
          </figure>
        </div>

        <section aria-labelledby="tasks-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">Start here · no wallet required</span>
          </div>
          <h2 className="section__title" id="tasks-heading">
            What do you want an agent to do?
          </h2>
          <p className="section__note">
            Four categories, deliberately at different depths right now, and each one says which. Browsing is
            anonymous: nothing on this site asks you to connect, sign or log in.
          </p>

          <Suspense fallback={<TaskGridPending />}>
            <TaskGrid />
          </Suspense>
        </section>

        <section aria-labelledby="mandate-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">The finished mandate</span>
          </div>
          <h2 className="section__title" id="mandate-heading">
            One agent, one job, start to finish, all of it on chain
          </h2>
          <p className="section__note">
            A trial on a pinned fork, a receipt in a registry with no owner, a session key bounded by the
            wallet&rsquo;s own account contract, a permitted repayment that executed, three boundary crossings
            the account refused before they could become transactions, and a revocation. Read it without an
            account.
          </p>
          <Suspense fallback={<MandatePending />}>
            <MandateSummary />
          </Suspense>
        </section>

        <section aria-labelledby="audience-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">Who this is for</span>
          </div>
          <h2 className="section__title" id="audience-heading">
            Three readers, three different questions
          </h2>
          <div className="grid-three spaced">
            <div className="card">
              <h3 className="listing__name">If you hold the capital</h3>
              <p className="listing__summary">
                You want to know what an agent can do to your position on its worst day, not on its best.
                Every agent page leads with the authority it would need and the boundary that stops it.
              </p>
            </div>
            <div className="card">
              <h3 className="listing__name">If you built the agent</h3>
              <p className="listing__summary">
                Your card is a claim until a trial makes it evidence. The ladder shows exactly which rung you
                are on and the specific, fixable reason you are not on the next one.
              </p>
            </div>
            <div className="card">
              <h3 className="listing__name">If you are here to check</h3>
              <p className="listing__summary">
                Nothing is read from a MANDATE database, because there is not one. Every page reads the chain
                and the documents it commits to, and the same checks run from a terminal.
              </p>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

function TaskGridPending() {
  return (
    <div aria-busy="true" className="tasks">
      {CATEGORIES.map((category) => (
        <span className="task" key={category.slug}>
          <span className="task__title">{category.task}</span>
          <span className="listing__summary">{category.decision}</span>
          <span className="task__meta">
            <span className="micro" role="status">
              Reading the registry for this category&rsquo;s evidence…
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * The four choices, each carrying its category's real depth.
 *
 * The rung shown is the strongest any agent in the category currently reaches.
 * A category with nothing published says so on the card rather than looking
 * identical to one with a finished mandate behind it, because the whole
 * argument of this site is that those two are not the same.
 */
async function TaskGrid() {
  const marketplace = await loadMarketplace(Math.floor(Date.now() / 1000));

  return (
    <div className="tasks">
      {CATEGORIES.map((category) => {
        const listings = listingsInCategory(marketplace, category);
        const ceiling = categoryCeiling(listings);

        return (
          <Link className="task" href={`/category/${category.slug}`} key={category.slug}>
            <span className="task__title">{category.task}</span>
            <span className="listing__summary">{category.decision}</span>
            <span className="task__meta">
              {ceiling === undefined ? (
                <span className="caption">
                  No agent published in this category yet. The page says what is missing.
                </span>
              ) : (
                <>
                  <ProvenanceLadder provenance={ceiling} />
                  <span className="micro tabular">
                    {listings.length} {listings.length === 1 ? "agent" : "agents"} · strongest rung shown
                  </span>
                </>
              )}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function MandatePending() {
  return (
    <div aria-busy="true" className="stack spaced">
      <div aria-hidden="true" className="skeleton skeleton--sm" />
    </div>
  );
}

async function MandateSummary() {
  const activation = await readActivationFact(FEATURED_MANDATE_ID);

  if (activation.observed !== "CONFIRMED") {
    return (
      <div className="empty spaced">
        <h3 className="empty__title">The registry did not confirm this mandate just now.</h3>
        <div className="empty__body">
          <p>
            {activation.reason ??
              `The registry on ${NETWORK_NAME} holds no activation under ${mandateLabel(FEATURED_MANDATE_ID)}.`}
          </p>
          <p>
            Nothing here is served from a cache of a previous read, so an endpoint that will not answer
            produces this message rather than a summary that might no longer be true.
          </p>
        </div>
        <div className="empty__actions">
          <Link className="button button--ghost" href={`/proof/${FEATURED_MANDATE_ID}`}>
            Open the proof page anyway
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="listing listing--r4 spaced">
      <div className="listing__head">
        <h3 className="listing__name">{mandateLabel(FEATURED_MANDATE_ID)}</h3>
        <ProvenanceLadder provenance="Mandate-native" />
      </div>
      <div className="listing__body">
        <p className="listing__summary">
          Granted {formatUtc(activation.validFrom)}, valid until {formatUtc(activation.validUntil)},{" "}
          {activation.revokedAt === 0
            ? "not revoked."
            : `revoked ${formatUtc(activation.revokedAt)}.`}{" "}
          Read from the receipt registry on chain {CHAIN_ID} at this request, not from a stored copy.
        </p>
        <p className="micro">
          The session key is gone, and the grant is still reconstructible: the activation record holds the
          window it was valid over, so a finished mandate can be read from the registry rather than guessed at
          from an account that now holds nothing.
        </p>
        <p>
          <Link className="button" href={`/proof/${FEATURED_MANDATE_ID}`}>
            Read the whole lifecycle
          </Link>
        </p>
      </div>
    </div>
  );
}

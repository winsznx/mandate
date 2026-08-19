import type { Metadata } from "next";
import Link from "next/link";
import { MARKETPLACE_FLOOR, QUALIFICATION_STAGES, provenanceCeilingFor } from "@mandate/domain";
import { ProvenanceLadder } from "../../src/components/provenance-ladder";
import { Page, SiteFooter } from "../../src/components/site-chrome";
import { RUNGS } from "../../src/marketplace/provenance-view";
import { proofLadder, withheldClaims } from "../../src/proof/claims";
import { FEATURED_MANDATE_ID } from "../../src/proof/config";

export const metadata: Metadata = {
  title: "Methodology",
  description:
    "What each rung of the provenance ladder means, what it takes to reach one, and why the rung an agent is shown at can be lower than the evidence it holds.",
};

const STAGE_MEANING: Record<(typeof QUALIFICATION_STAGES)[number], string> = {
  REGISTERED: "An ERC-8004 identity exists. It says nothing about whether anything is behind it.",
  ENDPOINT_VERIFIED:
    "The registration resolves to a well-formed card declaring at least one service.",
  CALLABLE: "The endpoint answered a real protocol handshake. Something is actually running.",
  CATEGORY_COMPATIBLE: "It declares and accepts a task shape for one of the four categories.",
  TRIAL_VERIFIED: "A specific version passed a reproducible MANDATE trial.",
  MANDATE_NATIVE: "It has executed under a live mandate, so its record is directly attributable.",
};

export default function MethodologyPage() {
  return (
    <Page current="/methodology">
      <main id="main">
        <p className="eyebrow spaced">Methodology</p>
        <h1 className="display">
          A ladder anyone can climb by assertion is decoration. Here is what each rung costs.
        </h1>
        <p className="lede">
          MANDATE never reduces evidence to a score, because the number would hide the only thing that
          matters: how the claim was established. A developer&rsquo;s assertion and a reproducible trial can
          describe the same behaviour and are not interchangeable. So provenance travels with every claim,
          it is displayed rather than averaged, and this page is the definition it is held to.
        </p>

        <section aria-labelledby="rungs-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">The evidence ladder</span>
          </div>
          <h2 className="section__title" id="rungs-heading">
            Six rungs, ordered by how the claim was established
          </h2>
          <p className="section__note">
            Ordering is by strength of attribution, not by how impressive the claim sounds. The rung of a set
            of evidence is always its weakest member&rsquo;s: presenting a mixed set at its strongest is the
            exact overstatement the taxonomy exists to prevent.
          </p>

          <dl className="rows spaced">
            {RUNGS.map((rung) => (
              <div className="row" key={rung.provenance}>
                <dt className="row__term">
                  <ProvenanceLadder provenance={rung.provenance} />
                </dt>
                <dd className="row__detail">
                  <p>{rung.meaning}</p>
                  <p>
                    <strong className="row__term">To reach it. </strong>
                    {rung.requirement}
                  </p>
                  <p className="micro">What it still does not tell you: {rung.limit}</p>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="stages-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">The second ladder</span>
          </div>
          <h2 className="section__title" id="stages-heading">
            How far an agent has proven it can be hired at all
          </h2>
          <p className="section__note">
            A registration is not an agent. BSC carries hundreds of thousands of ERC-8004 registrations, and a
            uniform sample of 300 found roughly three quarters to be bulk-mint entries from a single
            publisher, 3.2% declaring any service, and none declaring a skill. Presenting that inventory as a
            marketplace would be the same dishonesty as showing a claim beside a trial result and letting a
            reader assume they are equivalent. So identity and capability are graded separately. Everything on
            chain stays findable; only agents that answer, that fit the task and that carry evidence enter the
            primary ranking.
          </p>

          <dl className="rows spaced">
            {QUALIFICATION_STAGES.map((stage, index) => (
              <div className="row" key={stage}>
                <dt className="row__term">
                  <span className="mono">{stage.replace(/_/g, " ")}</span>
                  <span className="ladder__rank"> stage {index + 1} of {QUALIFICATION_STAGES.length}</span>
                </dt>
                <dd className="row__detail">
                  <p>{STAGE_MEANING[stage]}</p>
                  <p className="micro">
                    Strongest provenance this stage may be shown at: {provenanceCeilingFor(stage)}.
                    {stage === MARKETPLACE_FLOOR
                      ? " This is the floor for the primary ranking. Below it an agent still appears, clearly labelled, but never competes for placement beside one that completed a trial."
                      : ""}
                  </p>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="clamp-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">Where the two ladders meet</span>
          </div>
          <h2 className="section__title" id="clamp-heading">
            Why the rung you see can be lower than the evidence
          </h2>
          <div className="card spaced">
            <p className="prose">
              Every rung on this site is clamped before it is drawn. The evidence label an agent has earned is
              compared against what its current qualification can support, and the lower of the two is what
              appears. An agent that passed a trial in March and whose endpoint went dark in April holds real
              evidence and cannot be hired, and a marketplace that kept advertising the March result would be
              selling something that no longer exists.
            </p>
            <p className="prose spaced">
              When the clamp bites, the page says so on the agent, names the rung the evidence would have
              supported, and gives the reason. It never downgrades quietly, because a silent downgrade and a
              genuine absence of evidence look identical, and they are not the same thing at all.
            </p>
            <p className="prose spaced">
              Nothing on this site is currently shown at Mandate-verified. That rung needs the reference model
              replayed against the recorded observation, the model is hashed from its own source, and a page
              does not have that source. The command-line verifier reports it as a skip with the reason
              stated, and a skip is never rendered as a pass.
            </p>
          </div>
        </section>

        <section aria-labelledby="proof-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">How a claim gets made at all</span>
          </div>
          <h2 className="section__title" id="proof-heading">
            The nine-rung proof ladder behind the claim ledger
          </h2>
          <p className="section__note">
            Separate from the provenance taxonomy and answering a different question: not &ldquo;how was this
            agent&rsquo;s behaviour established&rdquo; but &ldquo;how far has MANDATE itself proven a
            statement it makes in public&rdquo;. Every claim on this site appears in{" "}
            <code className="mono">claims/ledger.json</code> with its rung. A claim absent from that file may
            not appear here, in the README or in a demo.
          </p>
          <ol className="rows spaced">
            {proofLadder().map((rung) => (
              <li className="row" key={rung.rung}>
                <span className="row__term tabular">Rung {rung.rung}</span>
                <span className="row__detail">{rung.description}</span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="withheld-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">The part most sites leave out</span>
          </div>
          <h2 className="section__title" id="withheld-heading">
            What MANDATE deliberately does not claim
          </h2>
          <p className="section__note">
            These entries exist in the ledger for the sole purpose of being refused. They are reproduced in
            full rather than summarised.
          </p>
          <ul className="stack spaced">
            {withheldClaims().map((claim) => (
              <li className="card" key={claim.claimId}>
                <p className="listing__name">{claim.wording}</p>
                <p className="micro spaced-sm">{claim.status.replace(/_/g, " ")}</p>
                <ul className="bullets spaced">
                  {claim.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="check-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">Do not take our word for it</span>
          </div>
          <h2 className="section__title" id="check-heading">
            Checking this yourself
          </h2>
          <div className="card spaced">
            <ul className="bullets">
              <li>
                Open the{" "}
                <Link className="link" href={`/proof/${FEATURED_MANDATE_ID}`}>
                  published proof
                </Link>
                . Every hash on it is recomputed on the server from the documents the chain committed to, not
                read from a field that asserts a verdict.
              </li>
              <li>
                Run <code className="mono">pnpm verify:mandate</code> from a terminal. It reads the same
                registry and the same documents and must reach the same verdict.
              </li>
              <li>
                Point either at your own endpoint with <code className="mono">MANDATE_RPC_URL</code>. If
                MANDATE could only be verified against infrastructure MANDATE controls, the verification would
                be worthless.
              </li>
            </ul>
          </div>
        </section>
      </main>

      <SiteFooter />
    </Page>
  );
}

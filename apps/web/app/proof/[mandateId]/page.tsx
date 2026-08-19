import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Hex } from "viem";
import { AuthorityMatch } from "../../../src/components/authority-match";
import {
  ExecutedEvidenceCard,
  MalformedEvidenceCard,
  RejectedIntentCard,
} from "../../../src/components/evidence-cards";
import { AddressLink, HashValue } from "../../../src/components/hash-value";
import { LifecycleList } from "../../../src/components/lifecycle-list";
import { StepList } from "../../../src/components/step-list";
import { VerdictBanner } from "../../../src/components/verdict-banner";
import { CHAIN_ID, FEATURED_AGENT, NETWORK_NAME } from "../../../src/proof/config";
import { establishedClaims, rungDescription, withheldClaims } from "../../../src/proof/claims";
import { formatUtc, mandateLabel, shortHash } from "../../../src/proof/format";
import { buildLifecycle } from "../../../src/proof/lifecycle";
import {
  ChainUnreachableError,
  loadProof,
  resolveMandate,
  UnknownMandateError,
} from "../../../src/proof/verify";
import type { ProofReport } from "../../../src/proof/verify";

/**
 * Read on every request rather than cached at build.
 *
 * A proof page that served a snapshot would keep printing "the account holds
 * this key" after a revocation, which is the exact failure the product exists
 * to prevent. The documents behind it are content-addressed and cached
 * separately, so the cost of being current is a handful of RPC reads.
 */
export const dynamic = "force-dynamic";

const MANDATE_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

interface PageProps {
  params: Promise<{ mandateId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { mandateId } = await params;
  if (!MANDATE_ID_PATTERN.test(mandateId)) notFound();
  return {
    title: mandateLabel(mandateId as Hex),
    description: `The complete lifecycle of mandate ${mandateId} on BSC testnet, verified against the chain and the published evidence.`,
  };
}

/**
 * The shell renders at once; the reads stream in behind a boundary.
 *
 * Deliberately not a `loading.tsx`. A route-level loading file makes Next
 * commit the response before the page runs, which forces an unknown mandate to
 * be served under a 200 with not-found copy in the body. Existence is settled
 * in `generateMetadata` above, so the status is correct, and the boundary here
 * still gives a reader something honest to look at during the several seconds
 * of chain reads and document fetches.
 */
export default async function ProofPage({ params }: PageProps) {
  const { mandateId } = await params;
  if (!MANDATE_ID_PATTERN.test(mandateId)) notFound();

  // Existence is settled before anything is flushed, so an unknown id answers
  // 404 rather than 200 with not-found copy in the body. Two reads, memoised,
  // and the body below reuses them. A chain that will not answer is
  // deliberately not a 404: "the registry says no such mandate" and "the
  // registry did not answer" are different facts, and the body reports the
  // second one with its own copy.
  try {
    await resolveMandate(mandateId as Hex);
  } catch (error) {
    if (error instanceof UnknownMandateError) notFound();
  }

  return (
    <div className="page">
      <header className="masthead">
        <Link className="wordmark" href="/">
          ✱ MANDATE
        </Link>
        <span className="masthead__meta">
          {NETWORK_NAME} · chain {CHAIN_ID}
        </span>
      </header>
      <Suspense fallback={<ProofPending />}>
        <ProofBody mandateId={mandateId as Hex} />
      </Suspense>
    </div>
  );
}

/**
 * What a reader sees while the chain is being read.
 *
 * Named placeholders rather than a spinner, so the wait says what is happening
 * and nothing on screen could be mistaken for a result. The pulse is dropped
 * entirely under `prefers-reduced-motion`.
 */
function ProofPending() {
  return (
    <main aria-busy="true" id="main">
      <p aria-live="polite" className="eyebrow spaced" role="status">
        Reading the receipt registry on {NETWORK_NAME} and fetching the documents it commits to. No verdict
        is shown until both have answered.
      </p>
      <div className="stack spaced">
        <div aria-hidden="true" className="skeleton skeleton--sm" />
        <div aria-hidden="true" className="skeleton skeleton--md" />
        <div aria-hidden="true" className="skeleton skeleton--lg" />
      </div>
    </main>
  );
}

async function ProofBody({ mandateId }: { mandateId: Hex }) {
  let report: ProofReport;
  try {
    report = await loadProof(mandateId, Math.floor(Date.now() / 1000));
  } catch (error) {
    if (error instanceof UnknownMandateError) notFound();
    if (error instanceof ChainUnreachableError) {
      return <ChainProblem endpoint={error.endpoint} detail={error.message} />;
    }
    throw error;
  }

  const lifecycle = buildLifecycle(report);
  const permitted = report.executed.filter((item) => item.outcome !== "REVERTED");

  return (
    <>
      <main id="main">
        <p className="eyebrow spaced">Independent proof · no wallet, no login</p>
        <h1 className="display">
          {FEATURED_AGENT.name} was given only the authority it proved.
        </h1>
        <p className="lede">
          Mandate {report.subject.label} on {report.network.name}. Everything below is read from the receipt
          registry at{" "}
          <AddressLink address={report.network.registry} label="0x4c2b…a299" /> and from the documents that
          registry commits to by hash. Nothing is read from a MANDATE database, because there is not one.
        </p>

        <VerdictBanner
          explanation={report.verdictExplanation}
          steps={report.steps}
          verdict={report.verdict}
        />

        <section aria-labelledby="match-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">The relation everything reduces to</span>
          </div>
          <h2 className="section__title" id="match-heading">
            Tested authority versus granted authority
          </h2>
          <p className="section__note">
            A trial proves an agent can do a job inside a stated envelope. A grant hands a session key real
            power over a real wallet. The product&rsquo;s only claim is that the second is never wider than
            the first, and the comparator below re-derives that from both documents rather than reading a
            verdict either of them asserts.
          </p>

          <div className="card spaced">
            {report.subsetView === undefined ? (
              <p className="prose">
                The two authority documents were not both available, so the relation could not be recomputed
                on this page. See the step list below for which document was missing and why.
              </p>
            ) : (
              <AuthorityMatch result={report.subsetResult} view={report.subsetView} />
            )}
          </div>
        </section>

        <section aria-labelledby="kinds-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">Two kinds of evidence, two different guarantees</span>
          </div>
          <h2 className="section__title" id="kinds-heading">
            What executed, and what was refused before it could
          </h2>
          <p className="section__note">
            These are not two flavours of the same thing. An executed action has a transaction anyone can
            fetch. A refused intent has none, because the wallet&rsquo;s own account contract evaluated it
            and declined to produce one. That is an earlier boundary than a reverted transaction, and it
            leaves a different artifact — so it is shown differently, and never with an explorer link.
          </p>

          <div className="grid-two spaced">
            <div className="stack">
              <h3 className="eyebrow">Executed · {permitted.length} on chain</h3>
              {permitted.length === 0 ? (
                <p className="panel caption">
                  No permitted execution was disclosed for this mandate, so there is nothing to fetch.
                </p>
              ) : (
                permitted.map((evidence) => (
                  <ExecutedEvidenceCard evidence={evidence} key={evidence.txHash} />
                ))
              )}
            </div>

            <div className="stack">
              <h3 className="eyebrow">Refused before broadcast · {report.rejected.length} intents</h3>
              {report.rejected.length === 0 ? (
                <p className="panel caption">
                  No refused intent was recorded for this mandate, so no boundary crossing is evidenced here.
                </p>
              ) : (
                report.rejected.map((evidence) => (
                  <RejectedIntentCard
                    evidence={evidence}
                    key={`${evidence.target}:${evidence.selector}:${evidence.label}`}
                  />
                ))
              )}
            </div>
          </div>

          {report.malformed.length === 0 ? null : (
            <div className="stack spaced">
              {report.malformed.map((item) => (
                <MalformedEvidenceCard key={item.label} label={item.label} reason={item.reason} />
              ))}
            </div>
          )}

          {report.spendWindow === undefined ? null : (
            <p className="section__note">
              The spend window that produced the cap refusal ran from {formatUtc(report.spendWindow.bucketStart)}{" "}
              to {formatUtc(report.spendWindow.bucketEnd)}
              {report.spendWindow.calendarAligned
                ? ". The run confirmed the account's bucket is calendar-aligned: it hard-resets at midnight UTC rather than trailing the last 24 hours."
                : ". The run did not confirm the bucket is calendar-aligned, so the reset boundary is not asserted here."}
            </p>
          )}
        </section>

        <section aria-labelledby="lifecycle-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">Start to finish</span>
          </div>
          <h2 className="section__title" id="lifecycle-heading">
            The lifecycle, in the order it happened
          </h2>
          <LifecycleList stages={lifecycle} />
        </section>

        <section aria-labelledby="steps-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">Independent verification</span>
          </div>
          <h2 className="section__title" id="steps-heading">
            Every check, including the ones that could not run
          </h2>
          <p className="section__note">
            The same twelve steps the command-line verifier prints, with the same three outcomes and the same
            reasons. A skip is not a soft pass: it means the check could not run, and it caps the verdict at
            PARTIALLY VERIFIED so nothing unchecked can be laundered into a clean result.
          </p>
          <div className="card spaced">
            <StepList steps={report.steps} />
          </div>
          <p className="section__note">
            Reproduce it against your own RPC:{" "}
            <code className="mono">pnpm verify:mandate {shortHash(report.subject.mandateId)}</code>. The
            command reads the same registry and the same documents and must reach the same verdict.
          </p>
        </section>

        <section aria-labelledby="record-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">The record</span>
          </div>
          <h2 className="section__title" id="record-heading">
            What is on chain, and what is only a document
          </h2>

          <div className="grid-two spaced">
            <div className="card">
              <h3 className="eyebrow">On chain</h3>
              <dl className="facts spaced">
                <div>
                  <dt>Mandate id</dt>
                  <dd>
                    <HashValue label="mandate id" value={report.subject.mandateId} />
                  </dd>
                </div>
                <div>
                  <dt>Receipt</dt>
                  <dd>
                    <HashValue label="receipt id" value={report.receipt.receiptId} />
                  </dd>
                </div>
                <div>
                  <dt>Agent</dt>
                  <dd>
                    #{report.receipt.agentId} on{" "}
                    <AddressLink address={report.receipt.identityRegistry} label="the ERC-8004 registry" />
                  </dd>
                </div>
                <div>
                  <dt>Wallet</dt>
                  <dd>
                    <AddressLink address={report.mandate.wallet} />
                  </dd>
                </div>
                <div>
                  <dt>Session key hash</dt>
                  <dd>
                    <HashValue label="session key hash" value={report.mandate.sessionKeyHash} />
                  </dd>
                </div>
                <div>
                  <dt>Granted authority hash</dt>
                  <dd>
                    <HashValue label="granted authority hash" value={report.mandate.grantedAuthorityHash} />
                  </dd>
                </div>
                <div>
                  <dt>Granted at</dt>
                  <dd>{formatUtc(report.mandate.validFrom)}</dd>
                </div>
                <div>
                  <dt>Valid until</dt>
                  <dd>{formatUtc(report.mandate.validUntil)}</dd>
                </div>
                <div>
                  <dt>Revoked at</dt>
                  {/* Printed even when there is no revocation. A missing row
                      would read as a question nobody asked rather than as an
                      answer, and this is the field a reader checks first. */}
                  <dd>{report.mandate.revokedAt === 0 ? "not revoked" : formatUtc(report.mandate.revokedAt)}</dd>
                </div>
                <div>
                  <dt>Tested authority hash</dt>
                  <dd>
                    <HashValue label="tested authority hash" value={report.receipt.testedAuthorityHash} />
                  </dd>
                </div>
                <div>
                  <dt>Trial result</dt>
                  <dd>{report.receipt.passed ? "PASS" : "FAIL"}</dd>
                </div>
                <div>
                  <dt>Fresh until</dt>
                  <dd>{formatUtc(report.receipt.freshUntil)}</dd>
                </div>
              </dl>
            </div>

            <div className="card">
              <h3 className="eyebrow">Documents</h3>
              <dl className="facts spaced">
                <div>
                  <dt>Evidence bundle</dt>
                  <dd>
                    <DocumentCell
                      encoding={report.documents.evidence.encoding}
                      problem={report.documents.evidence.problem}
                      uri={report.documents.evidence.uri}
                    />
                  </dd>
                </div>
                <div>
                  <dt>Mandate disclosure</dt>
                  <dd>
                    <DocumentCell
                      problem={report.documents.disclosure.problem}
                      uri={report.documents.disclosure.uri}
                    />
                  </dd>
                </div>
                <div>
                  <dt>Run record</dt>
                  <dd>
                    <DocumentCell
                      problem={report.documents.runRecord.problem}
                      uri={report.documents.runRecord.uri}
                    />
                  </dd>
                </div>
              </dl>
              <ul className="stack spaced">
                {report.notes.map((note) => (
                  <li className="micro" key={note}>
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section aria-labelledby="claims-heading" className="section">
          <div className="section__head">
            <span className="eyebrow">The claim ledger</span>
          </div>
          <h2 className="section__title" id="claims-heading">
            What this proves, and what it deliberately does not
          </h2>
          <p className="section__note">
            Read from <code className="mono">claims/ledger.json</code>, which is the binding statement of what
            MANDATE may assert. A claim absent from that file may not appear anywhere, and its withheld
            entries exist to record what is not being asserted.
          </p>

          <div className="grid-two spaced">
            <div className="card">
              <h3 className="eyebrow">Established</h3>
              <ul className="stack spaced">
                {establishedClaims().map((claim) => (
                  <li key={claim.claimId}>
                    <p className="caption">{claim.wording}</p>
                    <p className="micro">
                      {claim.status} · rung {claim.proofLevel}, {rungDescription(claim.proofLevel)}
                    </p>
                    {claim.limitations.map((limitation) => (
                      <p className="micro" key={limitation}>
                        Limitation: {limitation}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            </div>

            <div className="card">
              <h3 className="eyebrow">Not claimed</h3>
              <ul className="stack spaced">
                {withheldClaims().map((claim) => (
                  <li key={claim.claimId}>
                    <p className="caption">{claim.wording}</p>
                    <p className="micro">{claim.status}</p>
                    {claim.limitations.map((limitation) => (
                      <p className="micro" key={limitation}>
                        {limitation}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="section">
        <p className="micro">
          Everything on this page is BSC testnet, chain {report.network.chainId}. Read at{" "}
          {formatUtc(report.observedAt)} from {report.network.rpcUrl}. Point it at your own endpoint with{" "}
          <code className="mono">MANDATE_RPC_URL</code>.
        </p>
      </footer>
    </>
  );
}

function DocumentCell({
  uri,
  problem,
  encoding,
}: {
  uri: string;
  problem?: string | undefined;
  encoding?: string | undefined;
}) {
  return (
    <>
      {uri.length === 0 ? (
        <span className="micro">no URI recorded</span>
      ) : (
        <a className="link mono" href={uri} rel="noreferrer noopener" target="_blank">
          {uri.replace(/^https?:\/\//, "")}
        </a>
      )}
      {problem === undefined ? null : <p className="micro">{problem}</p>}
      {encoding === undefined ? null : (
        <p className="micro">
          {encoding === "CANONICAL_BYTES"
            ? "byte-identical to what the receipt hashed"
            : "re-encodes under MCJ/1 to the committed hash, which is sound but weaker than byte-identical"}
        </p>
      )}
    </>
  );
}

/**
 * The chain did not answer.
 *
 * Says which endpoint failed and what it failed at, and offers the two things a
 * reader can actually do about it. It never renders an empty page and never
 * renders a verdict, because a verdict computed from no reads would be a lie.
 */
function ChainProblem({ endpoint, detail }: { endpoint: string; detail: string }) {
  return (
    <main id="main">
        <h1 className="display spaced">The chain could not be read, so there is no verdict to show.</h1>
        <div className="problem spaced">
          <p className="problem__title">
            <span aria-hidden="true" className="status__glyph">
              !
            </span>
            {endpoint}
          </p>
          <p className="problem__body">{detail}</p>
        </div>
        <p className="prose spaced">
          Nothing on this page is cached from a previous read, so a failed endpoint produces this message
          rather than a stale proof. Retry, or point the page at another endpoint with{" "}
          <code className="mono">MANDATE_RPC_URL</code>. The command-line verifier takes the same override
          and does not depend on this page being up.
        </p>
    </main>
  );
}

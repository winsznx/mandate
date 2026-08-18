import {
  allowanceRuledOut,
  decodedReason,
  spendArithmetic,
} from "../proof/evidence-kind";
import type {
  ExecutedEvidence,
  RejectedIntentAccountState,
  RejectedIntentEvidence,
  SpendArithmetic,
} from "../proof/evidence-kind";
import { formatUnits } from "../proof/format";
import { contractLabel, selectorSignature, tokenInfo } from "../proof/known-addresses";
import { AddressLink, HashValue, TransactionLink } from "./hash-value";
import { StatusMark } from "./status-mark";

/**
 * The token every figure on this page is denominated in.
 *
 * Named once rather than repeated, because a wrong address here would silently
 * change the decimals and turn 25 USDT into 25,000,000.
 */
const USDT_ADDRESS = "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c" as const;

/** The two kinds carry different provenance weights, and the page says which. */
const PROVENANCE_TEXT: Record<string, string> = {
  CHAIN: "read from chain now",
  DISCLOSURE: "named in the disclosure the activation points at",
  RUN_RECORD: "from the run record, which nothing on chain commits to",
};

/**
 * Evidence that reached the chain.
 *
 * It has a transaction, so it gets a hash, an outcome re-read from a receipt,
 * and an outbound explorer link. This is the only card type on the page that
 * links out to BscScan.
 */
export function ExecutedEvidenceCard({ evidence }: { evidence: ExecutedEvidence }) {
  const label = evidence.target === undefined ? undefined : contractLabel(evidence.target);
  const signature = evidence.selector === undefined ? undefined : selectorSignature(evidence.selector);

  return (
    <article className="evidence--executed">
      <header className="evidence__head">
        <h3 className="evidence__kind">Executed · has a transaction</h3>
        <StatusMark status={evidence.outcome === "CONFIRMED" ? "PASS" : "SKIP"} />
        <span className="micro">
          {evidence.outcome === "CONFIRMED"
            ? "confirmed"
            : evidence.outcome === "REVERTED"
              ? "reverted on chain"
              : "not re-read"}
        </span>
      </header>

      <p className="evidence__label">{evidence.label}</p>

      <dl className="facts spaced">
        <div>
          <dt>Transaction</dt>
          <dd>
            <TransactionLink txHash={evidence.txHash} />
          </dd>
        </div>
        {evidence.target === undefined ? null : (
          <div>
            <dt>Contract</dt>
            <dd>
              <AddressLink address={evidence.target} label={label} />
            </dd>
          </div>
        )}
        {signature === undefined && evidence.selector === undefined ? null : (
          <div>
            <dt>Function</dt>
            <dd className="mono">{signature ?? evidence.selector}</dd>
          </div>
        )}
        {evidence.submittedTo === undefined ? null : (
          <div>
            <dt>Submitted to</dt>
            <dd>
              <AddressLink address={evidence.submittedTo} label={contractLabel(evidence.submittedTo)} />
              <span className="micro"> — a session key submits through a relay, so the sender is the relay</span>
            </dd>
          </div>
        )}
        {evidence.touchedGrantedTarget === undefined ? null : (
          <div>
            <dt>Attribution</dt>
            <dd className="micro">
              {evidence.touchedGrantedTarget
                ? "emitted an event from a contract inside the granted authority"
                : "emitted no event from a contract inside the granted authority"}
            </dd>
          </div>
        )}
        <div>
          <dt>Provenance</dt>
          <dd className="micro">{PROVENANCE_TEXT[evidence.provenance]}</dd>
        </div>
      </dl>

      {evidence.outcomeReason === undefined ? null : (
        <p className="micro spaced-sm">
          {evidence.outcomeReason}
        </p>
      )}
    </article>
  );
}

/**
 * The three numbers a skeptical reader actually wants.
 *
 * Cap, spent-so-far and standing allowance, side by side, because they are only
 * convincing together. The cap and the spend say the boundary was reached; the
 * allowance is what rules out the far more boring explanation, which is that
 * the token approval simply ran out. Those two failures are indistinguishable
 * from outside the account — same call, same absence of a transaction — so a
 * spend-cap claim published without the allowance is not checkable, and this
 * block is where a reader confirms it was.
 *
 * The subtraction is shown rather than asserted. "The cap was exceeded" is a
 * claim; 20 + 6 = 26 > 25 is a calculation the reader finishes themselves.
 */
function SpendCapProof({
  state,
  arithmetic,
  allowanceCovered,
}: {
  state: RejectedIntentAccountState;
  arithmetic: SpendArithmetic | undefined;
  allowanceCovered: boolean | undefined;
}) {
  if (arithmetic === undefined) return null;
  const usdt = tokenInfo(USDT_ADDRESS);
  const show = (raw: string): string => `${formatUnits(raw, usdt.decimals)} USDT`;

  return (
    <section aria-label="Why the spend cap and not the allowance refused this" className="constraint">
      <h4 className="constraint__title">What the account held at the attempt</h4>

      <dl className="constraint__figures">
        <div>
          <dt>Cap</dt>
          <dd className="tabular">{show(arithmetic.capRaw)}</dd>
          <p className="micro">granted, per UTC day</p>
        </div>
        <div>
          <dt>Already spent</dt>
          <dd className="tabular">{show(arithmetic.spentRaw)}</dd>
          <p className="micro">counted against this bucket</p>
        </div>
        <div>
          <dt>Allowance standing</dt>
          <dd className="tabular">
            {state.allowanceAtAttemptRaw === undefined ? "not recorded" : show(state.allowanceAtAttemptRaw)}
          </dd>
          <p className="micro">ERC-20 approval, unspent</p>
        </div>
      </dl>

      <p className="constraint__sum tabular">
        <span>{show(arithmetic.spentRaw)}</span>
        <span aria-hidden="true">+</span>
        <span className="visually-hidden">plus the</span>
        <span>{show(arithmetic.requestedRaw)}</span>
        <span aria-hidden="true">=</span>
        <span className="visually-hidden">attempted equals</span>
        <span>{show(arithmetic.wouldTotalRaw)}</span>
        <span aria-hidden="true">&gt;</span>
        <span className="visually-hidden">which is greater than the cap of</span>
        <span>{show(arithmetic.capRaw)}</span>
        <span className="constraint__over">over by {show(arithmetic.overByRaw)}</span>
      </p>

      {state.allowanceAtAttemptRaw === undefined ? (
        <p className="constraint__note">
          The allowance at the attempt was not recorded, so an exhausted ERC-20 approval cannot be ruled out
          as the real cause. This page will not describe the refusal as a spend-cap refusal on that evidence.
        </p>
      ) : allowanceCovered === true ? (
        <p className="constraint__note">
          The allowance is what rules out the boring explanation. {show(state.allowanceAtAttemptRaw)} was
          still approved and only {show(arithmetic.requestedRaw)} was attempted, so the token approval had
          room many times over. It was the granted cap that refused this, not an approval that had run out —
          and those two look identical from outside the account, which is why the number is published.
        </p>
      ) : (
        <p className="constraint__note">
          The allowance standing was below the amount attempted, so the approval and not the granted cap was
          the binding constraint. This refusal does not evidence the spend cap.
        </p>
      )}
    </section>
  );
}

/**
 * Evidence that never reached the chain.
 *
 * The whole card is built so that no reader — sighted, greyscale, screen
 * reader, or someone looking at a screenshot — can mistake it for a
 * transaction. The heading names the difference, the surface and border differ
 * from an executed card, and a dedicated block states in plain language that
 * there is nothing to open and why that is the stronger outcome.
 *
 * There is no explorer link anywhere in this component, and the type it renders
 * has no field one could be built from.
 */
export function RejectedIntentCard({ evidence }: { evidence: RejectedIntentEvidence }) {
  const label = contractLabel(evidence.target);
  const signature = selectorSignature(evidence.selector);
  const arithmetic = spendArithmetic(evidence);
  const allowanceCovered = allowanceRuledOut(evidence);
  const usdt = tokenInfo(USDT_ADDRESS);

  return (
    <article className="evidence--rejected">
      <header className="evidence__head">
        <h3 className="evidence__kind">Refused before broadcast · no transaction</h3>
        <span className="status status--fail">
          <span className="status__glyph" aria-hidden="true">
            ✕
          </span>
          REFUSED
        </span>
      </header>

      <p className="evidence__label">{evidence.label}</p>

      <SpendCapProof
        allowanceCovered={allowanceCovered}
        arithmetic={arithmetic}
        state={evidence.accountState}
      />

      <dl className="facts spaced">
        <div>
          <dt>Requested action</dt>
          <dd>
            {label ?? "an unlabelled contract"} <HashValue label="target" value={evidence.target} />
            <span className="mono"> · {signature ?? evidence.selector}</span>
            {evidence.amountRaw === undefined ? null : (
              <span> · {formatUnits(evidence.amountRaw, usdt.decimals)} USDT</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Validator error</dt>
          <dd className="mono">{evidence.validatorError}</dd>
        </div>
        {evidence.accountState.callPermitted === undefined ? null : (
          <div>
            <dt>Account&rsquo;s own canExecute</dt>
            <dd>{evidence.accountState.callPermitted ? "permitted" : "false for this contract and function"}</dd>
          </div>
        )}
        {evidence.accountState.keyRegistered === undefined ? null : (
          <div>
            <dt>Account holds the key</dt>
            <dd>{evidence.accountState.keyRegistered ? "yes" : "no"}</dd>
          </div>
        )}
        <div>
          <dt>Provenance</dt>
          <dd className="micro">{PROVENANCE_TEXT[evidence.provenance]}</dd>
        </div>
      </dl>


      <p className="evidence__no-tx">
        <strong>There is no transaction to open.</strong> The account&rsquo;s validator evaluated this intent
        and declined to produce one. {decodedReason(evidence)} That is an earlier boundary than a reverted
        transaction: a revert means the call was signed, broadcast, ordered into a block and executed before
        anything stopped it. Here none of that happened, so no explorer has a record and no hash exists. The
        evidence is the account state above and the error its validator raised.
      </p>
    </article>
  );
}

/** A record the page will not render as evidence, shown rather than dropped. */
export function MalformedEvidenceCard({ label, reason }: { label: string; reason: string }) {
  return (
    <article className="problem">
      <h3 className="problem__title">
        <span className="status__glyph" aria-hidden="true">
          !
        </span>
        Unrenderable record
      </h3>
      <p className="problem__body">
        <strong>{label}</strong> — {reason}
      </p>
    </article>
  );
}

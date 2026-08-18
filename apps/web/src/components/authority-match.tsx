import type { SubsetResult } from "@mandate/authority-ir";
import { subsetHeadline } from "../proof/subset";
import type { FacetRelation, SubsetView } from "../proof/subset";

const FACET_LABEL: Record<string, string> = {
  TARGET: "Contract",
  FUNCTION: "Function",
  SPEND: "Spend",
  LIFETIME: "Lifetime",
};

const RELATION_LABEL: Record<FacetRelation, string> = {
  SAME: "same",
  NARROWER: "narrower than tested",
  WIDER: "wider than tested",
  TESTED_ONLY: "tested, not granted",
  GRANTED_ONLY: "granted, never tested",
};

/**
 * TESTED beside GRANTED.
 *
 * A real `<table>` rather than two stacked lists, because the comparison is the
 * content: the reader's eye has to travel across a row, and a screen reader has
 * to be able to announce "Spend, tested, USDT less than or equal to 25 per UTC
 * day". Row headers carry the facet so neither reading loses the label.
 *
 * The result line is rendered from the comparator's own verdict, not from the
 * rows. A renderer that decided its own verdict could disagree with the
 * comparator the CLI re-runs, and the page would have no way to notice.
 */
export function AuthorityMatch({ view, result }: { view: SubsetView; result: SubsetResult | undefined }) {
  const subset = result?.subset ?? false;

  return (
    <div>
      <div className="match">
        <table className="match__table">
          <caption>
            Every facet of the authority the trial tested, beside the authority the wallet granted. Both
            documents are the ones the chain committed to by hash.
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Facet</span>
              </th>
              <th scope="col">Tested</th>
              <th scope="col">Granted</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.id}>
                <th className="match__facet" scope="row">
                  {FACET_LABEL[row.facet] ?? row.facet}
                </th>
                <td className="match__value">
                  {row.tested ?? <span className="match__value--absent">not in the tested envelope</span>}
                </td>
                <td className="match__value">
                  {row.granted ?? <span className="match__value--absent">not granted</span>}
                  <span className="match__relation">{RELATION_LABEL[row.relation]}</span>
                  {row.note === undefined ? null : <span className="match__note">{row.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={`match__result${subset ? "" : " match__result--broken"}`}>
        <span className="eyebrow">Result</span>
        <br />
        <strong className="match__result-line">{subsetHeadline(subset)}</strong>
      </p>

      <p className="section__note">
        {result === undefined
          ? "The relation was not recomputed on this page, because one of the two documents was not authenticated against its on-chain hash."
          : `Recomputed here by comparator ${result.comparatorVersion}, not read from the artifact's proof block. The CLI verifier runs the same comparator and must reach the same answer.`}
      </p>

      <p className="section__note">
        The spend window is a UTC calendar bucket, and the page says so rather than smoothing it over. It
        hard-resets at midnight UTC instead of trailing the last 24 hours, so a cap nearly exhausted at 23:59
        UTC is fully available again at 00:01 UTC. Describing it as a moving window would name an enforcement
        the account contract does not implement, and would understate what a session can spend across a
        boundary.
      </p>
    </div>
  );
}

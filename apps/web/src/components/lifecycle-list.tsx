import type { LifecycleStage } from "../proof/lifecycle";
import { RejectedIntentCard } from "./evidence-cards";
import { TransactionLink } from "./hash-value";

/**
 * The lifecycle in order.
 *
 * Transactions and refusals are rendered from two separate fields by two
 * separate blocks. Nothing here iterates a mixed list, so no future edit can
 * accidentally emit an explorer link for a refusal that never had one.
 */
export function LifecycleList({ stages }: { stages: readonly LifecycleStage[] }) {
  return (
    <ol className="lifecycle">
      {stages.map((stage) => (
        <li className="stage" key={stage.id}>
          <span aria-hidden="true" className="stage__ordinal">
            {String(stage.ordinal).padStart(2, "0")}
          </span>
          <div className="stage__body">
            <div>
              <h3 className="stage__title">
                <span className="visually-hidden">Stage {stage.ordinal}: </span>
                {stage.title}
              </h3>
              <p className="stage__summary">{stage.summary}</p>
            </div>

            {stage.transactions.length === 0 ? null : (
              <div className="tx-list">
                {stage.transactions.map((transaction) => (
                  <p className="tx-row" key={transaction.txHash}>
                    <span className="tx-row__label">{transaction.label}</span>
                    <TransactionLink txHash={transaction.txHash} />
                  </p>
                ))}
              </div>
            )}

            {stage.rejections.length === 0
              ? null
              : stage.rejections.map((rejection) => (
                  <RejectedIntentCard evidence={rejection} key={`${rejection.target}:${rejection.label}`} />
                ))}

            {stage.detail.length === 0 ? null : (
              <dl className="facts">
                {stage.detail.map((entry) => (
                  <div key={entry.label}>
                    <dt>{entry.label}</dt>
                    <dd className="caption">{entry.value}</dd>
                  </div>
                ))}
              </dl>
            )}

            {stage.missing === undefined ? null : <p className="micro">{stage.missing}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

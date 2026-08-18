import type { Step } from "../proof/steps";
import { StatusMark } from "./status-mark";

/**
 * The verifier's step list, printed whole.
 *
 * Every step appears, including the ones that could not run, because a silently
 * omitted line reads as "fine". Every non-PASS carries its reason, because
 * "FAIL" without a cause is an accusation and "SKIP" without a cause is an
 * excuse. There is no bare green tick anywhere in this component.
 */
export function StepList({ steps }: { steps: readonly Step[] }) {
  return (
    <ol className="steps">
      {steps.map((step) => (
        <li className="step" key={step.id}>
          <h3 className="step__id">{step.id}</h3>
          <StatusMark status={step.status} />
          <div>
            <p className="step__reason">{step.reason ?? "no reason recorded"}</p>
            {step.detail === undefined ? null : (
              <dl className="step__detail">
                {Object.entries(step.detail).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

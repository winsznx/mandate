import type { Step, Verdict } from "../proof/steps";
import { StatusMark } from "./status-mark";

/**
 * One of four words, and the sentence that produced it.
 *
 * Never rendered as a colour alone and never without the explanation. PRD §88
 * is explicit that a proof page must not print green or red without saying what
 * it means, and the four words carry information a boolean would destroy: a
 * receipt whose evidence hash is wrong is in a completely different position
 * from one that verifies but expired last week.
 */
export function VerdictBanner({
  verdict,
  explanation,
  steps,
}: {
  verdict: Verdict;
  explanation: string;
  steps: readonly Step[];
}) {
  const counts = {
    PASS: steps.filter((step) => step.status === "PASS").length,
    SKIP: steps.filter((step) => step.status === "SKIP").length,
    FAIL: steps.filter((step) => step.status === "FAIL").length,
  };

  return (
    <section aria-labelledby="verdict-heading" className="verdict">
      <h2 className="eyebrow" id="verdict-heading">
        Verdict
      </h2>
      <p className="verdict__word">{verdict}</p>
      <p className="prose spaced">{explanation}</p>

      <div className="verdict__counts">
        <span>
          <StatusMark status="PASS" /> <span className="micro">{counts.PASS} of {steps.length} steps</span>
        </span>
        <span>
          <StatusMark status="SKIP" /> <span className="micro">{counts.SKIP} could not be checked here</span>
        </span>
        <span>
          <StatusMark status="FAIL" /> <span className="micro">{counts.FAIL} contradicted</span>
        </span>
      </div>
    </section>
  );
}

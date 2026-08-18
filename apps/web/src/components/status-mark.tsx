import type { StepStatus } from "../proof/steps";
import { statusGlyph, statusLabel } from "../proof/steps";

/**
 * A status, said three ways at once.
 *
 * A glyph, a text label and a tone. All three are always present, so the status
 * is readable in greyscale, on a monochrome printout, to a colour-blind reader
 * and inside a screenshot. The glyph is decorative to assistive technology
 * because the label beside it already carries the meaning; announcing both
 * would read the status twice.
 */
export function StatusMark({ status }: { status: StepStatus }) {
  const modifier = status === "PASS" ? "pass" : status === "FAIL" ? "fail" : "skip";

  return (
    <span className={`status status--${modifier}`}>
      <span className="status__glyph" aria-hidden="true">
        {statusGlyph(status)}
      </span>
      {statusLabel(status)}
    </span>
  );
}

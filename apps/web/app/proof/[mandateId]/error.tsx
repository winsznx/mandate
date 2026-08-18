"use client";

/**
 * The last line of defence.
 *
 * Reached only when something failed that the verification path did not model —
 * an unreachable RPC and an unknown mandate are both handled upstream with
 * their own copy. It prints what went wrong and offers a retry, and it never
 * prints a verdict, because a verdict derived from a failed read would be worse
 * than no page at all.
 */
export default function ProofError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="page">
      <header className="masthead">
        <span className="wordmark">✱ MANDATE</span>
      </header>
      <main id="main">
        <h1 className="display spaced">This proof could not be assembled.</h1>
        <div className="problem spaced" role="alert">
          <p className="problem__title">
            <span aria-hidden="true" className="status__glyph">
              !
            </span>
            Verification did not complete
          </p>
          <p className="problem__body">{error.message}</p>
        </div>
        <p className="prose spaced">
          Nothing above is a partial result. The page reads the chain and the published documents on every
          request, so a failure here means the read did not finish, not that a check failed. The command-line
          verifier reads the same sources and does not depend on this page.
        </p>
        <p className="spaced">
          <button className="button" onClick={reset} type="button">
            Try the read again
          </button>
        </p>
      </main>
    </div>
  );
}

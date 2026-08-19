import type { ProofManifestView } from "../proof/documents";
import { HashValue } from "./hash-value";

/**
 * Who held which key.
 *
 * The shortest true statement of what MANDATE does is "the owner granted, the
 * agent executed, the owner revoked", and it only means anything if those are
 * different parties. Three addresses on the page is what turns that from a
 * claim into something a reader checks for themselves.
 *
 * The residual gap is printed rather than omitted: both keys are currently held
 * by the MANDATE team, so this demonstrates key separation and not yet an
 * arm's-length relationship between a capital owner and an agent operator.
 */
export function RolesPanel({ roles }: { roles: NonNullable<ProofManifestView["roles"]> }) {
  const collapsed = roles.separation.ownerIsAgent;

  return (
    <section aria-label="Who held which key" className="panel">
      <h2 className="section-heading">Who held which key</h2>

      <dl className="fact-grid">
        <dt>Owner</dt>
        <dd>
          <HashValue value={roles.owner.address} />
          <span className="constraint-note">{roles.owner.holds}</span>
        </dd>

        <dt>Agent</dt>
        <dd>
          <HashValue value={roles.agent.address} />
          <span className="constraint-note">{roles.agent.holds}</span>
        </dd>

        <dt>Session key</dt>
        <dd>
          <HashValue value={roles.agent.sessionKey} />
          <span className="constraint-note">
            Signed every execution in this run. Derived per run, because revocation is monotonic
            and a reused key would work exactly once.
          </span>
        </dd>

        <dt>Publisher</dt>
        <dd>
          <HashValue value={roles.publisher.address} />
          <span className="constraint-note">
            {roles.publisher.sameAs === "owner"
              ? "The owner publishes, declared rather than left to be inferred."
              : "Publishes the receipt and the lifecycle records."}
          </span>
        </dd>
      </dl>

      <p className="constraint-note">
        {collapsed
          ? "These roles share an address, so this run demonstrates enforcement but no arm's-length relationship."
          : roles.separation.assertion}
      </p>

      {roles.agent.designationNote !== undefined ? (
        <p className="constraint-note">{roles.agent.designationNote}</p>
      ) : null}

      <p className="constraint-note">
        <strong>What this still does not show:</strong> both keys are held by the MANDATE team. The
        account enforced the boundary regardless of who holds them — holding both cannot make an
        account refuse a call it would otherwise permit — but a capital owner and an agent operator
        being genuinely different parties has not been demonstrated.
      </p>
    </section>
  );
}

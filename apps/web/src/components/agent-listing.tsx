import Link from "next/link";
import { provenanceRank } from "@mandate/domain";
import type { AgentListing } from "../marketplace/provenance-view";
import { endpointAnswered } from "../marketplace/endpoint";
import { ProvenanceLadder } from "./provenance-ladder";

/**
 * One agent, given as much page as its rung earns.
 */
export function AgentListingCard({ listing }: { listing: AgentListing }) {
  const rank = provenanceRank(listing.provenance);
  const detailHref =
    listing.agentId === undefined
      ? undefined
      : (`/agents/${listing.identityRegistry}/${listing.agentId}` as const);

  const isLive = endpointAnswered(listing.endpoint);

  return (
    <article className={`listing listing--r${rank}`}>
      <div className="listing__head">
        <h3 className="listing__name">
          {detailHref === undefined ? (
            listing.card.name
          ) : (
            <Link className="link" href={detailHref}>
              {listing.card.name}
            </Link>
          )}
        </h3>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <span
            className="micro"
            style={{
              padding: "0.2rem 0.5rem",
              borderRadius: "4px",
              background: isLive ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
              color: isLive ? "var(--color-green, #10b981)" : "var(--color-red, #ef4444)",
              fontWeight: "bold",
            }}
          >
            {isLive ? "LIVE ENDPOINT" : "OFFLINE"}
          </span>
          <ProvenanceLadder provenance={listing.provenance} size={rank >= 3 ? "lg" : "sm"} />
        </div>
      </div>

      <div className="listing__body">
        <p className="listing__summary">{listing.card.description}</p>

        <div className="chips">
          {listing.agentId && (
            <span className="chip" style={{ background: "var(--surface-subtle, #1e293b)" }}>
              ERC-8004 #{listing.agentId}
            </span>
          )}
          <span className="chip">{listing.category.name}</span>
          {listing.card.skills.map((skill) => (
            <span className="chip" key={skill.id}>
              {skill.name}
            </span>
          ))}
        </div>

        {listing.clamped && listing.clampReason !== undefined ? (
          <div className="listing__clamp">
            <p className="listing__clamp-title">
              <span aria-hidden="true" className="status__glyph">
                !
              </span>
              Shown lower than its evidence
            </p>
            <p>{listing.clampReason}</p>
          </div>
        ) : null}

        <div>
          <h4 className="eyebrow">What has been established</h4>
          <ul className="listing__evidence spaced-sm">
            {listing.proved.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>

        {listing.outstanding.length === 0 ? null : (
          <div>
            <h4 className="eyebrow">What has not</h4>
            <ul className="bullets spaced-sm">
              {listing.outstanding.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h4 className="eyebrow">Required authority in one sentence</h4>
          <p className="listing__summary">{listing.category.authorityShape}</p>
        </div>

        {listing.chainUnreadable ? (
          <p className="micro">
            At least one chain read failed on this request, so this rung may be understated.
          </p>
        ) : null}

        <div className="hero__actions" style={{ marginTop: "1rem", gap: "0.5rem" }}>
          {detailHref !== undefined && (
            <Link className="button button--ghost" href={detailHref}>
              Inspect Evidence &nearr;
            </Link>
          )}
          <Link className="button button--ghost" href={`/compare?a=${listing.card.slug}`}>
            Compare Agent
          </Link>
          <Link
            className="button"
            href={`/mandates/0xae988cd9815bb6db588dc09423d94a339cc029d29a69d27e679f631c2f6d8d9b`}
          >
            Activate / Hire Agent
          </Link>
        </div>
      </div>
    </article>
  );
}

import Link from "next/link";
import { provenanceRank } from "@mandate/domain";
import type { AgentListing } from "../marketplace/provenance-view";
import { ProvenanceLadder } from "./provenance-ladder";

/**
 * One agent, given as much page as its rung earns.
 *
 * The density is the argument. A Claimed agent is a flat panel with body type
 * and one line saying the description is the developer's own account; a
 * Mandate-native one gets Paper White, a solid rule, heading-weight type and
 * room for its evidence. Nothing here uses colour to make that distinction, and
 * the rung is always spelled out in words as well as drawn.
 */
export function AgentListingCard({ listing }: { listing: AgentListing }) {
  const rank = provenanceRank(listing.provenance);
  const detailHref =
    listing.agentId === undefined
      ? undefined
      : (`/agents/${listing.identityRegistry}/${listing.agentId}` as const);

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
        <ProvenanceLadder provenance={listing.provenance} size={rank >= 3 ? "lg" : "sm"} />
      </div>

      <div className="listing__body">
        <p className="listing__summary">{listing.card.description}</p>

        {listing.card.skills.length === 0 ? null : (
          <ul className="chips">
            {listing.card.skills.map((skill) => (
              <li className="chip" key={skill.id}>
                {skill.name}
              </li>
            ))}
          </ul>
        )}

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
          <h4 className="eyebrow">Authority a mandate here would grant</h4>
          <p className="listing__summary">{listing.category.authorityShape}</p>
        </div>

        {listing.chainUnreadable ? (
          <p className="micro">
            At least one chain read failed on this request, so this rung may be understated. It is never
            overstated by a failed read: an unconfirmed record is treated as absent.
          </p>
        ) : null}

        {detailHref === undefined ? (
          <p className="micro">
            No ERC-8004 registration on the identity registry resolves to this card, so there is no agent
            page to open. A card in a repository is a file; a card a registration points at is a public
            commitment.
          </p>
        ) : (
          <p>
            <Link className="link" href={detailHref}>
              What this agent can do, and what it would need
            </Link>
          </p>
        )}
      </div>
    </article>
  );
}

import Link from "next/link";
import { FEATURED_MANDATE_ID, RECEIPT_REGISTRY } from "../src/proof/config";
import { mandateLabel } from "../src/proof/format";

/**
 * The registry answered, and it does not know this id.
 *
 * Deliberately different from the chain-unreachable page. "The chain says no
 * such mandate" and "the chain did not answer" are different facts, and
 * collapsing them would let an endpoint outage read as a missing record.
 */
export default function NotFound() {
  return (
    <div className="page">
      <header className="masthead">
        <Link className="wordmark" href="/">
          ✱ MANDATE
        </Link>
      </header>
      <main id="main">
        <h1 className="display spaced">No mandate with that id.</h1>
        <p className="prose spaced">
          The receipt registry at <span className="mono">{RECEIPT_REGISTRY}</span> on BSC testnet answered,
          and it holds no activation under that id. A mandate id is 32 bytes, hex, and is derived from the
          wallet, the receipt, the granted authority hash and the renewal sequence — so a mistyped one
          resolves to nothing rather than to something else.
        </p>
        <p className="spaced">
          <Link className="button" href={`/proof/${FEATURED_MANDATE_ID}`}>
            Open {mandateLabel(FEATURED_MANDATE_ID)}, the published proof
          </Link>
        </p>
      </main>
    </div>
  );
}

import Link from "next/link";
import { CHAIN_ID, FEATURED_AGENT, FEATURED_MANDATE_ID, NETWORK_NAME } from "../src/proof/config";
import { mandateLabel } from "../src/proof/format";

/**
 * One door, and it opens onto the proof.
 *
 * There is no marketplace here, no listing and no hire flow. The only thing
 * this deployment has evidence for is one finished mandate, and a landing page
 * offering more than that would be claiming more than that.
 */
export default function Home() {
  return (
    <div className="page">
      <header className="masthead">
        <span className="wordmark">✱ MANDATE</span>
        <span className="masthead__meta">
          {NETWORK_NAME} · chain {CHAIN_ID}
        </span>
      </header>

      <main id="main">
        <p className="eyebrow spaced">Proof explorer</p>
        <h1 className="display">See what the agent proved. Then see exactly what it was given.</h1>
        <p className="lede">
          One finished mandate, start to finish: a trial on a pinned fork, a receipt in a registry with no
          owner, a session key bounded by the wallet&rsquo;s own account contract, one permitted repayment on
          chain, and the boundary crossings that never became transactions at all.
        </p>

        <p className="spaced">
          <Link className="button" href={`/proof/${FEATURED_MANDATE_ID}`}>
            Open the proof for {mandateLabel(FEATURED_MANDATE_ID)}
          </Link>
        </p>

        <div className="card spaced">
          <h2 className="section__title">What you will not need</h2>
          <ul className="stack spaced">
            <li className="prose">A wallet. The page reads a public RPC and nothing is signed.</li>
            <li className="prose">An account. There is no login and no session.</li>
            <li className="prose">
              To trust us. Every hash on the page is recomputed in your browser&rsquo;s request from the
              documents the chain committed to, and the same checks run from a terminal with{" "}
              <code className="mono">pnpm verify:mandate</code>.
            </li>
          </ul>
        </div>

        <div className="card spaced">
          <h2 className="section__title">The agent</h2>
          <p className="prose spaced">
            {FEATURED_AGENT.name}, agent #{FEATURED_AGENT.agentId} on the ERC-8004 identity registry. It was
            tested on one job — repaying a Venus vUSDT position to restore a health factor — and granted
            authority to do that job and nothing else.
          </p>
          <p className="micro spaced">
            Everything demonstrated here is BSC testnet, chain {CHAIN_ID}. No mainnet claim is made.
          </p>
        </div>
      </main>
    </div>
  );
}

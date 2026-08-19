import Link from "next/link";
import type { ReactNode } from "react";
import { CHAIN_ID, NETWORK_NAME } from "../proof/config";

const NAV = [
  { href: "/", label: "Marketplace" },
  { href: "/methodology", label: "Methodology" },
  { href: "/status", label: "Status" },
] as const;

/**
 * The same header on every page, with the network stated on every page.
 *
 * The chain is in the masthead rather than in a footnote because it changes
 * what every number below it means. A reader who scrolls into a figure without
 * having seen "BSC Testnet" has been allowed to assume the wrong thing.
 */
export function Masthead({ current }: { current?: string | undefined }) {
  return (
    <header className="masthead">
      <Link className="wordmark" href="/">
        ✱ MANDATE
      </Link>
      <nav aria-label="Sections" className="masthead__nav">
        {NAV.map((item) => (
          <Link
            aria-current={item.href === current ? "page" : undefined}
            className="masthead__link"
            href={item.href}
            key={item.href}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <span className="masthead__meta">
        {NETWORK_NAME} · chain {CHAIN_ID}
      </span>
    </header>
  );
}

export function SiteFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className="site-footer">
      <div className="site-footer__row">
        <Link className="masthead__link" href="/methodology">
          What the rungs mean
        </Link>
        <Link className="masthead__link" href="/status">
          System status
        </Link>
      </div>
      {children}
      <p className="micro spaced">
        Everything on this site is {NETWORK_NAME}, chain {CHAIN_ID}. No mainnet claim is made anywhere. No
        wallet is required to read any page, and nothing here asks you to sign.
      </p>
    </footer>
  );
}

/** A page shell. Every route uses it so the landmarks and the skip target stay identical. */
export function Page({ current, children }: { current?: string | undefined; children: ReactNode }) {
  return (
    <div className="page">
      <Masthead current={current} />
      {children}
    </div>
  );
}

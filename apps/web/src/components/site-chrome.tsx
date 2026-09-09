import Link from "next/link";
import type { ReactNode } from "react";
import { CHAIN_ID, FEATURED_MANDATE_ID, NETWORK_NAME } from "../proof/config";
import { WalletControl } from "./wallet-control";

const NAV = [
  { href: "/marketplace", label: "Marketplace" },
  { href: "/mandates", label: "My Mandates" },
  { href: "/compare", label: "Compare" },
  { href: "/developers", label: "Developers" },
] as const;

export function Masthead({ current }: { current?: string | undefined }) {
  return (
    <header className="masthead">
      <div className="masthead__top-row">
        <Link className="wordmark" href="/">
          <span aria-hidden="true" className="wordmark__mark">
            ✱
          </span>
          MANDATE
        </Link>
        <div className="masthead__actions">
          <span className="masthead__meta">
            {NETWORK_NAME} ({CHAIN_ID})
          </span>
          <WalletControl />
        </div>
      </div>
      <nav aria-label="Sections" className="masthead__nav">
        {NAV.map((item) => (
          <Link
            aria-current={item.href === current || (item.href === "/marketplace" && current === "/") ? "page" : undefined}
            className="masthead__link"
            href={item.href}
            key={item.href}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function SiteFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className="site-footer">
      <div className="site-footer__row">
        <Link className="masthead__link" href="/demo">
          Guided Demo Mode
        </Link>
        <Link className="masthead__link" href="/reports/agent-advantage">
          TermiX Agent Advantage Report
        </Link>
        <Link className="masthead__link" href={`/proof/${FEATURED_MANDATE_ID}`}>
          Proof Verification
        </Link>
        <Link className="masthead__link" href="/methodology">
          Methodology & Provenance
        </Link>
        <Link className="masthead__link" href="/status">
          System Status
        </Link>
      </div>
      {children}
      <p className="micro spaced">
        Everything on this site is {NETWORK_NAME}, chain {CHAIN_ID}. No mainnet claim is made anywhere. No
        wallet is required to browse, and no simulated transactions are presented as real.
      </p>
    </footer>
  );
}

export function Page({ current, children }: { current?: string | undefined; children: ReactNode }) {
  return (
    <div className="page">
      <Masthead current={current} />
      <main id="main">{children}</main>
    </div>
  );
}

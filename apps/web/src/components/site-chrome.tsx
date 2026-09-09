"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CHAIN_ID, FEATURED_MANDATE_ID, NETWORK_NAME } from "../proof/config";
import { WalletControl } from "./wallet-control";

const NAV = [
  { href: "/marketplace", label: "Marketplace", icon: "/brand/icons/marketplace.svg" },
  { href: "/mandates", label: "My Mandates", icon: "/brand/icons/mandates.svg" },
  { href: "/compare", label: "Compare", icon: "/brand/icons/compare.svg" },
  { href: "/developers", label: "Developers", icon: "/brand/icons/developers.svg" },
] as const;

const SECONDARY_NAV = [
  { href: "/demo", label: "Guided demo", icon: "/brand/icons/status.svg" },
  { href: `/proof/${FEATURED_MANDATE_ID}`, label: "Proof verification", icon: "/brand/icons/proof.svg" },
  { href: "/status", label: "System status", icon: "/brand/icons/status.svg" },
  { href: "/methodology", label: "Methodology & provenance", icon: "/brand/icons/proof.svg" },
] as const;

export function Masthead({ current }: { current?: string | undefined }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menuOpen) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  return (
    <header className="masthead">
      <div className="masthead__brand-group">
        <Link className="wordmark" href="/" onClick={closeMenu}>
          <img
            alt=""
            className="wordmark__mark-img"
            height="22"
            src="/brand/mark.svg"
            width="22"
          />
          <span className="wordmark__text">MANDATE</span>
        </Link>

        <nav aria-label="Main Navigation" className="masthead__desktop-nav">
          {NAV.map((item) => {
            const isActive = item.href === current;
            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`masthead__link ${isActive ? "masthead__link--active" : ""}`}
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="masthead__actions">
        <WalletControl />
        <button
          aria-expanded={menuOpen}
          aria-label="Toggle mobile menu"
          className="masthead__menu-trigger"
          onClick={() => setMenuOpen(!menuOpen)}
          type="button"
        >
          <span aria-hidden="true" className="masthead__menu-icon">
            {menuOpen ? "✕" : "☰"}
          </span>
          <span className="sr-only">Menu</span>
        </button>
      </div>

      {menuOpen && (
        <div className="mobile-sheet-overlay" onClick={closeMenu}>
          <div
            aria-label="Mobile menu"
            className="mobile-sheet"
            onClick={(e) => e.stopPropagation()}
            ref={menuRef}
            role="dialog"
          >
            <div className="mobile-sheet__header">
              <span className="wordmark">
                <img
                  alt=""
                  className="wordmark__mark-img"
                  height="22"
                  src="/brand/mark.svg"
                  width="22"
                />
                <span className="wordmark__text">MANDATE</span>
              </span>
              <button
                aria-label="Close menu"
                className="mobile-sheet__close"
                onClick={closeMenu}
                type="button"
              >
                ✕
              </button>
            </div>

            <nav aria-label="Mobile navigation" className="mobile-sheet__nav">
              {NAV.map((item) => {
                const isActive = item.href === current;
                return (
                  <Link
                    aria-current={isActive ? "page" : undefined}
                    className={`mobile-sheet__link ${isActive ? "mobile-sheet__link--active" : ""}`}
                    href={item.href}
                    key={item.href}
                    onClick={closeMenu}
                  >
                    <img alt="" className="mobile-sheet__icon" height="16" src={item.icon} width="16" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="mobile-sheet__divider" />

            <nav
              aria-label="Mobile secondary navigation"
              className="mobile-sheet__secondary-nav"
            >
              {SECONDARY_NAV.map((item) => (
                <Link
                  className="mobile-sheet__secondary-link"
                  href={item.href}
                  key={item.href}
                  onClick={closeMenu}
                >
                  <img alt="" className="mobile-sheet__icon" height="14" src={item.icon} width="14" />
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="mobile-sheet__footer">
              <span className="micro">
                {NETWORK_NAME} · Chain {CHAIN_ID}
              </span>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

export function SiteFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className="site-footer">
      <div className="site-footer__grid">
        <div className="site-footer__brand-col">
          <Link className="site-footer__brand-link" href="/">
            <img
              alt="MANDATE"
              className="site-footer__logo"
              height="24"
              src="/brand/logo-horizontal.svg"
              width="130"
            />
          </Link>
          <p className="caption site-footer__tagline">
            Evidence-bound authority for financial agents.
          </p>
        </div>

        <div className="site-footer__col">
          <span className="site-footer__heading">Product</span>
          <nav aria-label="Footer Product links" className="site-footer__nav">
            <Link className="site-footer__link" href="/marketplace">
              Marketplace
            </Link>
            <Link className="site-footer__link" href="/mandates">
              My Mandates
            </Link>
            <Link className="site-footer__link" href="/compare">
              Compare
            </Link>
            <Link className="site-footer__link" href="/demo">
              Guided Demo
            </Link>
          </nav>
        </div>

        <div className="site-footer__col">
          <span className="site-footer__heading">Resources</span>
          <nav aria-label="Footer Resources links" className="site-footer__nav">
            <Link className="site-footer__link" href="/developers">
              Developers
            </Link>
            <Link
              className="site-footer__link"
              href={`/proof/${FEATURED_MANDATE_ID}`}
            >
              Proof
            </Link>
            <Link className="site-footer__link" href="/methodology">
              Methodology
            </Link>
            <Link className="site-footer__link" href="/status">
              System Status
            </Link>
            <a
              className="site-footer__link"
              href="https://github.com/winsznx/mandate"
              rel="noreferrer"
              target="_blank"
            >
              GitHub &nearr;
            </a>
          </nav>
        </div>
      </div>

      {children}

      <div className="site-footer__bottom">
        <span className="micro">
          {NETWORK_NAME} · Chain {CHAIN_ID}
        </span>
        <span className="micro text-tertiary">
          No mainnet claims. Enforceable session bounds on BSC Testnet.
        </span>
      </div>
    </footer>
  );
}

export function Page({
  current,
  children,
}: {
  current?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <Masthead current={current} />
      <main id="main">{children}</main>
    </div>
  );
}

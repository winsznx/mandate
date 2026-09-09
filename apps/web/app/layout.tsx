import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Inter_Tight } from "next/font/google";
import { Web3Providers } from "../src/web3/providers";
import "./globals.css";

const displayFont = Inter_Tight({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-display-loaded",
  display: "swap",
});

const bodyFont = Inter({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-body-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://mandate-web.timjosh507.workers.dev"),
  title: {
    default: "MANDATE — Evidence-Bound Authority for Financial Agents",
    template: "%s · MANDATE",
  },
  description:
    "Find financial agents, see what they proved, and grant only matching onchain authority.",
  icons: {
    icon: [
      { url: "/brand/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/favicon.png", type: "image/png" },
    ],
    shortcut: "/brand/favicon.svg",
    apple: "/brand/app-icon-light.png",
  },
  openGraph: {
    title: "MANDATE — Evidence-Bound Authority for Financial Agents",
    description:
      "Find financial agents, see what they proved, and grant only matching onchain authority.",
    url: "https://mandate-web.timjosh507.workers.dev",
    siteName: "MANDATE",
    images: [
      {
        url: "https://mandate-web.timjosh507.workers.dev/brand/og-card.png",
        width: 1200,
        height: 630,
        alt: "MANDATE — Evidence-Bound Authority for Financial Agents",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "MANDATE — Evidence-Bound Authority for Financial Agents",
    description:
      "Find financial agents, see what they proved, and grant only matching onchain authority.",
    images: ["https://mandate-web.timjosh507.workers.dev/brand/og-card.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <body>
        <Web3Providers>
          <a className="skip-link" href="#main">
            Skip to main content
          </a>
          {children}
        </Web3Providers>
      </body>
    </html>
  );
}

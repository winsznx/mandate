import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, Inter_Tight } from "next/font/google";
import "./globals.css";

/**
 * Duna asks for GT America, which is licensed. Inter Tight carries the same
 * compressed, geometric authority at display sizes; Inter handles body and UI.
 * Both are self-hosted by next/font at build, so nothing is fetched at runtime.
 */
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
  title: {
    default: "MANDATE proof",
    template: "%s · MANDATE proof",
  },
  description:
    "The complete lifecycle of one agent mandate on BSC testnet, read from chain and from published evidence. No wallet, no login.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to the proof
        </a>
        {children}
      </body>
    </html>
  );
}

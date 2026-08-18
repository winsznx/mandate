import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

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
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to the proof
        </a>
        {children}
      </body>
    </html>
  );
}

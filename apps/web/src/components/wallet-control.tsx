"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

export function WalletControl() {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        mounted,
      }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        if (!ready) {
          return (
            <button disabled className="button button--ghost wallet-btn" type="button">
              <span className="status__glyph">◌</span>
              Connecting...
            </button>
          );
        }

        if (!connected) {
          return (
            <button
              onClick={openConnectModal}
              className="button wallet-btn"
              type="button"
            >
              Connect wallet
            </button>
          );
        }

        if (chain.unsupported) {
          return (
            <button
              onClick={openChainModal}
              className="button button--blocked wallet-btn"
              type="button"
            >
              <span className="status__glyph">×</span>
              Switch network
            </button>
          );
        }

        return (
          <button
            onClick={openAccountModal}
            className="button button--ghost wallet-btn wallet-btn--connected"
            type="button"
            title={`Connected to ${chain.name} (${chain.id})`}
          >
            <span
              className="status__glyph"
              style={{ color: "var(--status-verified)" }}
            >
              ●
            </span>
            <span className="tabular mono">{account.displayName}</span>
            <span aria-hidden="true" className="wallet-btn__chevron">
              ▾
            </span>
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}

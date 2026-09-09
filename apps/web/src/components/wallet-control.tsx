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
            <button disabled className="button button--ghost" type="button">
              <span className="status__glyph">◌</span>
              Connecting...
            </button>
          );
        }

        if (!connected) {
          return (
            <button
              onClick={openConnectModal}
              className="button"
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
              className="button button--blocked"
              type="button"
            >
              <span className="status__glyph">×</span>
              Switch network
            </button>
          );
        }

        return (
          <div className="wallet-control">
            <button
              onClick={openChainModal}
              className="wallet-control__chain"
              type="button"
              title={`Connected to ${chain.name}`}
            >
              <span className="status__glyph">●</span>
              {chain.name} ({chain.id})
            </button>
            <button
              onClick={openAccountModal}
              className="button button--ghost wallet-control__account"
              type="button"
            >
              <span className="tabular mono">{account.displayName}</span>
            </button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

import { explorerAddressUrl, explorerTxUrl } from "../proof/config";
import { shortAddress, shortHash } from "../proof/format";
import type { Address, Hex } from "viem";

/**
 * A long value, abbreviated for reading and complete for checking.
 *
 * The full string is always in the DOM — as the element's `title` and as
 * visually hidden text — so a reader can copy it, a screen reader can read it,
 * and page search finds it. An abbreviation with no expansion would make the
 * page unusable for the one task it exists for.
 */
export function HashValue({ value, label }: { value: string; label?: string | undefined }) {
  return (
    <span className="mono" title={value}>
      <span aria-hidden="true">{shortHash(value)}</span>
      <span className="visually-hidden">
        {label === undefined ? "" : `${label}: `}
        {value}
      </span>
    </span>
  );
}

/** A transaction that exists. Only ever rendered for executed evidence. */
export function TransactionLink({ txHash, children }: { txHash: Hex; children?: string | undefined }) {
  return (
    <a className="link mono" href={explorerTxUrl(txHash)} rel="noreferrer noopener" target="_blank">
      {children ?? shortHash(txHash)}
      <span className="visually-hidden"> — open transaction {txHash} on BscScan, opens in a new tab</span>
    </a>
  );
}

export function AddressLink({ address, label }: { address: Address; label?: string | undefined }) {
  return (
    <a className="link" href={explorerAddressUrl(address)} rel="noreferrer noopener" target="_blank">
      {label ?? <span className="mono">{shortAddress(address)}</span>}
      <span className="visually-hidden"> — open {address} on BscScan, opens in a new tab</span>
    </a>
  );
}

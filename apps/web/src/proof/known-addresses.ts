/**
 * Labels for the contracts this deployment touches.
 *
 * Display only. Every label on the page is rendered beside the address it
 * names, never instead of it, so a wrong label here is visible rather than
 * load-bearing. Nothing is resolved by name and no lookup service is consulted:
 * an address whose label is missing renders as the address.
 *
 * Decimals are a display concern. The protocol counts base units, and every
 * number the page compares — caps, spends, allowances — is compared raw.
 */
import type { Address } from "viem";

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

const CHAIN_97_CONTRACTS: Record<string, string> = {
  "0xb7526572ffe56ab9d7489838bf2e18e3323b441a": "Venus vUSDT",
  "0x94d1820b2d1c7c7452a163983dc888cec546b77d": "Venus Comptroller",
  "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c": "USDT",
  "0xd5c4c2e2facbeb59d0216d0595d63fcdc6f9a1a7": "a Venus vToken outside the permission set",
  "0xcb5cef3c54aa90e9a7ad602a258d3d360cc862b9": "Altana Orchestrator",
  "0x6b8361c29d05d498b1a12b54a37310f94171e94a": "Altana KeyStore",
  "0x33ad2f49ab9f122f5f0fdf579f575724eff353de": "Altana account implementation",
  "0x0791af52629206b5434a6865e9e1536a493854ca": "MANDATE ReceiptRegistry",
  "0x8004a818bfb912233c491871b3d84c89a494bd9e": "ERC-8004 IdentityRegistry",
};

const CHAIN_97_TOKENS: Record<string, TokenInfo> = {
  "0xa11c8d9dc9b66e209ef60f0c8d969d3cd988782c": { symbol: "USDT", decimals: 6 },
};

/** The chain's own currency, which an AuthorityIR spend limit names as `NATIVE`. */
export const NATIVE_TOKEN: TokenInfo = { symbol: "tBNB", decimals: 18 };

export function contractLabel(address: Address): string | undefined {
  return CHAIN_97_CONTRACTS[address.toLowerCase()];
}

export function tokenInfo(token: Address | "NATIVE"): TokenInfo {
  if (token === "NATIVE") return NATIVE_TOKEN;
  return CHAIN_97_TOKENS[token.toLowerCase()] ?? { symbol: "units", decimals: 0 };
}

/** Known 4-byte selectors, so a reader is not asked to trust `0x0e752702` on sight. */
const SELECTOR_SIGNATURES: Record<string, string> = {
  "0x0e752702": "repayBorrow(uint256)",
  "0xc5ebeaec": "borrow(uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x32323232": "any selector (wildcard)",
};

export function selectorSignature(selector: string): string | undefined {
  return SELECTOR_SIGNATURES[selector.toLowerCase()];
}

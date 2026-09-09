# Contributions & Upstream Findings

MANDATE's verification against live protocol deployments on BNB Smart Chain yielded several critical findings regarding account risk, wallet permissions, and protocol state reconstruction.

---

## 1. Venus Protocol `getAssetsIn` Debt Omission Bug

- **Location**: `contributions/venus-getassetsin/README.md`
- **Impact**: High (Security & Solvency Analysis)
- **Summary**: Standard risk monitors reconstruct account collateral and debt by calling Venus Comptroller `getAssetsIn(account)` to find active markets. However, VAI (Venus Algorithmic Stablecoin) minting does NOT add VAI to `getAssetsIn`. A risk monitor relying solely on `getAssetsIn` reads a heavily leveraged account with VAI debt as having zero debt, failing to trigger liquidation protection.
- **Fix / Mitigation**: MANDATE's `packages/venus-bsc` explicitly queries `vaiMinted(account)` in addition to `getAssetsIn(account)` when calculating account Health Factor.

---

## 2. Wallet Stack Requested vs. Enforced Permission Discrepancy

- **Impact**: Medium (Authority Precision)
- **Summary**: Embedded wallet orchestrators silently append wildcard call permissions (`0x*`) for internal relayer operations onto user-requested permission objects. As a result, the requested permission JSON is NOT what the chain actually enforces.
- **Mitigation**: MANDATE's `packages/altana` reads the *effective enforced permissions* back from the account bytecode (`canExecutePackedInfos`, `spendInfos`) and displays the enforced boundary rather than the requested payload.

---

## 3. Transient vs. Durable ERC-20 Approvals

- **Impact**: Medium (Session Hygiene)
- **Summary**: Session-path ERC-20 approvals are force-zeroed by the account contract at the end of every batch execution. Standing approvals on the admin path survive session revocation until explicitly cleared.
- **Mitigation**: MANDATE tracks admin-path approvals as durable effects and provides explicit single-click revocation/clearing in the product UI.

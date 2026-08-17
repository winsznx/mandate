// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title ScopeHashLib
/// @notice Deterministic identifiers shared between Solidity and TypeScript.
/// @dev Mirrors `packages/domain/src/ids.ts`. The two are held together by golden
///      vectors in `test/ScopeHashLib.t.sol`, which read the same fixture file the
///      TypeScript suite hashes, so a change to either side fails the build rather
///      than silently producing receipts a verifier cannot reproduce.
///
///      Document hashes (trial specs, authority envelopes, evidence bundles) are
///      NOT computed here. Those are keccak256 over canonical JSON, which is
///      produced off-chain; this contract only ever receives the resulting
///      bytes32. Hashing JSON on-chain would buy nothing, since the registry
///      stores commitments rather than interpreting them.
library ScopeHashLib {
    /// @notice Domain separator for receipt identifiers.
    /// @dev keccak256("mandate.receipt-id/1")
    bytes32 internal constant RECEIPT_ID_DOMAIN = keccak256("mandate.receipt-id/1");

    /// @notice Domain separator for mandate identifiers.
    /// @dev keccak256("mandate.mandate-id/1")
    bytes32 internal constant MANDATE_ID_DOMAIN = keccak256("mandate.mandate-id/1");

    /// @notice Fields a receipt identifier commits to.
    /// @dev Grouped into a struct purely to stay under the local-variable limit;
    ///      the encoding below is flat and order-sensitive.
    struct ReceiptIdInput {
        uint256 chainId;
        address publisher;
        address identityRegistry;
        uint256 agentId;
        bytes32 agentVersionHash;
        bytes32 trialSpecHash;
        bytes32 testedAuthorityHash;
        bytes32 scenarioHash;
        bytes32 evaluatorHash;
        bytes32 referenceModelHash;
        bytes32 evidenceHash;
        uint64 snapshotBlock;
        uint64 createdAt;
        uint64 freshUntil;
        bool passed;
        bytes32 evidenceURIHash;
    }

    /// @notice Derive a receipt identifier.
    /// @dev `chainId` and `publisher` are in the preimage so a receipt cannot be
    ///      replayed onto another chain or re-attributed to a different publisher.
    ///      `evidenceURI` enters as a hash to keep every field fixed-width.
    ///
    ///      Every member of `ReceiptIdInput` is a static type, so the struct is a
    ///      static tuple and `abi.encode` lays its fields out head-to-tail with no
    ///      offset word. The result is therefore byte-identical to encoding the
    ///      sixteen fields individually, which is what the TypeScript side does —
    ///      passing the struct only avoids a stack-too-deep in the flat form.
    ///      `test/ScopeHashLib.t.sol` pins the equivalence against shared vectors.
    function receiptId(ReceiptIdInput memory input) internal pure returns (bytes32) {
        return keccak256(abi.encode(RECEIPT_ID_DOMAIN, input));
    }

    /// @notice Derive a mandate identifier.
    /// @param sequence Increments on renewal, so a renewed mandate is a new record
    ///        rather than a mutation of the previous one.
    function mandateId(
        uint256 chainId,
        address wallet,
        bytes32 trialReceiptId,
        bytes32 grantedAuthorityHash,
        uint32 sequence
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(MANDATE_ID_DOMAIN, chainId, wallet, trialReceiptId, grantedAuthorityHash, sequence)
        );
    }
}

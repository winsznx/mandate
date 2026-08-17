// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IMandateReceiptRegistry} from "./IMandateReceiptRegistry.sol";
import {ScopeHashLib} from "./ScopeHashLib.sol";

/// @title MandateReceiptRegistry
/// @notice Append-only public record of what MANDATE trials found and which
///         mandates were activated from them.
///
/// @dev The registry deliberately does very little. It does not score agents, it
///      does not decide whether evidence supports a result, and it does not hold
///      user funds. What it records is a claim with an author attached: publisher
///      P committed result R for agent A under spec T using evidence E, at a time
///      nobody can move afterwards. Reading the evidence and deciding whether to
///      believe it stays with whoever cares.
///
///      Three properties make the record worth anything:
///
///      1. Append-only. Publishing under an existing id reverts. Nothing is ever
///         mutated or deleted, so a failed trial cannot be quietly rewritten once
///         it is inconvenient.
///      2. No privileged surface. There is no owner, no pause, no upgrade path.
///         The deployer keeps no ability the public does not have, so "trust the
///         registry operator" is not part of the security model.
///      3. Identifier-bound content. A receipt id is derived from every field it
///         commits to, including the chain and the publisher, so a receipt cannot
///         be replayed onto another chain or re-attributed.
///
///      `recordActivation` additionally enforces on-chain the one rule that would
///      otherwise rest on application code: a mandate cannot be activated from a
///      trial that did not pass.
contract MandateReceiptRegistry is IMandateReceiptRegistry {
    /// @notice Upper bound on the stored evidence URI.
    /// @dev Bounded so a single publication cannot make the contract expensive to
    ///      read. Long enough for an R2 key, an ipfs:// CID or an https URL.
    uint256 public constant MAX_EVIDENCE_URI_LENGTH = 512;

    mapping(bytes32 receiptId => StoredReceipt) private _receipts;
    mapping(bytes32 mandateId => Activation) private _activations;

    /// @notice Publication order, so an indexer can enumerate without log replay.
    bytes32[] private _receiptIds;

    /// @inheritdoc IMandateReceiptRegistry
    function publishReceipt(Receipt calldata receipt, string calldata evidenceURI)
        external
        returns (bytes32 receiptId)
    {
        _validate(receipt, evidenceURI);

        receiptId = _computeReceiptId(receipt, msg.sender, evidenceURI);

        // publishedAt is only ever zero before the first write, which makes it a
        // sound existence check without a second mapping.
        if (_receipts[receiptId].publishedAt != 0) revert ReceiptAlreadyPublished(receiptId);

        _receipts[receiptId] = StoredReceipt({
            receipt: receipt,
            publisher: msg.sender,
            publishedAt: uint64(block.timestamp),
            evidenceURI: evidenceURI
        });
        _receiptIds.push(receiptId);

        emit ReceiptPublished(
            receiptId,
            msg.sender,
            receipt.identityRegistry,
            receipt.agentId,
            receipt.agentVersionHash,
            receipt.trialSpecHash,
            receipt.testedAuthorityHash,
            receipt.evidenceHash,
            receipt.passed,
            evidenceURI
        );
    }

    /// @inheritdoc IMandateReceiptRegistry
    /// @dev `attestedBy` is recorded as `msg.sender` and nothing more is claimed.
    ///      The registry cannot verify that a session key really carries the stated
    ///      permissions, so it does not pretend to; a verifier checks the session
    ///      against the wallet's own state. What is enforced here is the part that
    ///      can be: the referenced receipt exists and passed.
    function recordActivation(
        bytes32 trialReceiptId,
        address wallet,
        bytes32 sessionKeyHash,
        bytes32 grantedAuthorityHash,
        uint32 sequence,
        string calldata disclosureURI
    ) external returns (bytes32 mandateId) {
        StoredReceipt storage stored = _receipts[trialReceiptId];
        if (stored.publishedAt == 0) revert UnknownReceipt(trialReceiptId);
        if (!stored.receipt.passed) revert ReceiptDidNotPass(trialReceiptId);

        if (wallet == address(0)) revert InvalidReceiptField("wallet");
        if (sessionKeyHash == bytes32(0)) revert InvalidReceiptField("sessionKeyHash");
        if (grantedAuthorityHash == bytes32(0)) revert InvalidReceiptField("grantedAuthorityHash");

        // An activation nobody can fetch the granted authority for is a
        // commitment to a document that exists only in MANDATE's database, which
        // defeats the point of committing to it.
        uint256 uriLength = bytes(disclosureURI).length;
        if (uriLength == 0) revert InvalidReceiptField("disclosureURI");
        if (uriLength > MAX_EVIDENCE_URI_LENGTH) revert EvidenceURITooLong(uriLength);

        mandateId = ScopeHashLib.mandateId(
            block.chainid, wallet, trialReceiptId, grantedAuthorityHash, sequence
        );

        if (_activations[mandateId].activatedAt != 0) revert MandateAlreadyActivated(mandateId);

        _activations[mandateId] = Activation({
            trialReceiptId: trialReceiptId,
            wallet: wallet,
            sessionKeyHash: sessionKeyHash,
            grantedAuthorityHash: grantedAuthorityHash,
            attestedBy: msg.sender,
            activatedAt: uint64(block.timestamp),
            disclosureURI: disclosureURI
        });

        emit MandateActivated(
            mandateId,
            trialReceiptId,
            wallet,
            sessionKeyHash,
            grantedAuthorityHash,
            msg.sender,
            disclosureURI
        );
    }

    /// @inheritdoc IMandateReceiptRegistry
    function getReceipt(bytes32 receiptId) external view returns (StoredReceipt memory) {
        StoredReceipt memory stored = _receipts[receiptId];
        if (stored.publishedAt == 0) revert UnknownReceipt(receiptId);
        return stored;
    }

    /// @inheritdoc IMandateReceiptRegistry
    function receiptExists(bytes32 receiptId) external view returns (bool) {
        return _receipts[receiptId].publishedAt != 0;
    }

    /// @inheritdoc IMandateReceiptRegistry
    function getActivation(bytes32 mandateId) external view returns (Activation memory) {
        return _activations[mandateId];
    }

    /// @inheritdoc IMandateReceiptRegistry
    function computeReceiptId(Receipt calldata receipt, address publisher, string calldata evidenceURI)
        external
        view
        returns (bytes32)
    {
        return _computeReceiptId(receipt, publisher, evidenceURI);
    }

    /// @inheritdoc IMandateReceiptRegistry
    function receiptCount() external view returns (uint256) {
        return _receiptIds.length;
    }

    /// @notice Receipt id at a publication index, for enumeration.
    function receiptIdAt(uint256 index) external view returns (bytes32) {
        return _receiptIds[index];
    }

    function _computeReceiptId(Receipt calldata receipt, address publisher, string calldata evidenceURI)
        private
        view
        returns (bytes32)
    {
        return ScopeHashLib.receiptId(
            ScopeHashLib.ReceiptIdInput({
                chainId: block.chainid,
                publisher: publisher,
                identityRegistry: receipt.identityRegistry,
                agentId: receipt.agentId,
                agentVersionHash: receipt.agentVersionHash,
                trialSpecHash: receipt.trialSpecHash,
                testedAuthorityHash: receipt.testedAuthorityHash,
                scenarioHash: receipt.scenarioHash,
                evaluatorHash: receipt.evaluatorHash,
                referenceModelHash: receipt.referenceModelHash,
                evidenceHash: receipt.evidenceHash,
                snapshotBlock: receipt.snapshotBlock,
                createdAt: receipt.createdAt,
                freshUntil: receipt.freshUntil,
                passed: receipt.passed,
                evidenceURIHash: keccak256(bytes(evidenceURI))
            })
        );
    }

    /// @dev Rejects receipts that could not describe a real trial. These are
    ///      cheap structural checks, not a judgement about the evidence.
    function _validate(Receipt calldata receipt, string calldata evidenceURI) private pure {
        if (receipt.identityRegistry == address(0)) revert InvalidReceiptField("identityRegistry");
        if (receipt.agentVersionHash == bytes32(0)) revert InvalidReceiptField("agentVersionHash");
        if (receipt.trialSpecHash == bytes32(0)) revert InvalidReceiptField("trialSpecHash");
        if (receipt.testedAuthorityHash == bytes32(0)) revert InvalidReceiptField("testedAuthorityHash");
        if (receipt.evidenceHash == bytes32(0)) revert InvalidReceiptField("evidenceHash");
        if (receipt.createdAt == 0) revert InvalidReceiptField("createdAt");
        if (receipt.freshUntil <= receipt.createdAt) revert InvalidReceiptField("freshUntil");

        uint256 length = bytes(evidenceURI).length;
        if (length == 0) revert InvalidReceiptField("evidenceURI");
        if (length > MAX_EVIDENCE_URI_LENGTH) revert EvidenceURITooLong(length);
    }
}

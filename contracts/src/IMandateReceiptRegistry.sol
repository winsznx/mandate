// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title IMandateReceiptRegistry
/// @notice Public, append-only record of trial outcomes and the mandates derived from them.
interface IMandateReceiptRegistry {
    /// @notice What a trial certified.
    /// @dev Every field is a commitment computed off-chain. The registry stores
    ///      them; it does not interpret them and makes no claim that the evidence
    ///      supports the result.
    struct Receipt {
        address identityRegistry;
        uint256 agentId;
        bytes32 agentVersionHash;
        bytes32 trialSpecHash;
        /// @dev Ceiling on every authority derived from this receipt.
        bytes32 testedAuthorityHash;
        bytes32 scenarioHash;
        bytes32 evaluatorHash;
        bytes32 referenceModelHash;
        bytes32 evidenceHash;
        uint64 snapshotBlock;
        uint64 createdAt;
        /// @dev After this the receipt is history, not current certification.
        uint64 freshUntil;
        bool passed;
    }

    struct StoredReceipt {
        Receipt receipt;
        address publisher;
        uint64 publishedAt;
        string evidenceURI;
    }

    struct Activation {
        bytes32 trialReceiptId;
        address wallet;
        bytes32 sessionKeyHash;
        bytes32 grantedAuthorityHash;
        address attestedBy;
        uint64 activatedAt;
        /// @dev Where the granted AuthorityIR can be fetched.
        ///      Without it, `grantedAuthorityHash` lets a reader CHECK a document
        ///      they were handed but never OBTAIN one, so an independent verifier
        ///      working from chain alone could not evaluate the subset relation at
        ///      all. The hash remains what is trusted; this is only how to find
        ///      the bytes.
        string disclosureURI;
    }

    event ReceiptPublished(
        bytes32 indexed receiptId,
        address indexed publisher,
        address indexed identityRegistry,
        uint256 agentId,
        bytes32 agentVersionHash,
        bytes32 trialSpecHash,
        bytes32 testedAuthorityHash,
        bytes32 evidenceHash,
        bool passed,
        string evidenceURI
    );

    event MandateActivated(
        bytes32 indexed mandateId,
        bytes32 indexed trialReceiptId,
        address indexed wallet,
        bytes32 sessionKeyHash,
        bytes32 grantedAuthorityHash,
        address attestedBy,
        string disclosureURI
    );

    error ReceiptAlreadyPublished(bytes32 receiptId);
    error MandateAlreadyActivated(bytes32 mandateId);
    error UnknownReceipt(bytes32 receiptId);
    /// @dev A failed trial can never back a live mandate. Enforced on-chain so the
    ///      claim does not rest on application code.
    error ReceiptDidNotPass(bytes32 receiptId);
    error InvalidReceiptField(string field);
    error EvidenceURITooLong(uint256 length);

    function publishReceipt(Receipt calldata receipt, string calldata evidenceURI)
        external
        returns (bytes32 receiptId);

    function recordActivation(
        bytes32 trialReceiptId,
        address wallet,
        bytes32 sessionKeyHash,
        bytes32 grantedAuthorityHash,
        uint32 sequence,
        string calldata disclosureURI
    ) external returns (bytes32 mandateId);

    function getReceipt(bytes32 receiptId) external view returns (StoredReceipt memory);

    function receiptExists(bytes32 receiptId) external view returns (bool);

    function getActivation(bytes32 mandateId) external view returns (Activation memory);

    function computeReceiptId(Receipt calldata receipt, address publisher, string calldata evidenceURI)
        external
        view
        returns (bytes32);

    function receiptCount() external view returns (uint256);
}

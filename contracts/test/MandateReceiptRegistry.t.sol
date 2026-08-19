// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IMandateReceiptRegistry} from "../src/IMandateReceiptRegistry.sol";
import {MandateReceiptRegistry} from "../src/MandateReceiptRegistry.sol";
import {ScopeHashLib} from "../src/ScopeHashLib.sol";

contract MandateReceiptRegistryTest is Test {
    MandateReceiptRegistry private registry;

    address private constant PUBLISHER = address(0xBEEF);
    address private constant OTHER_PUBLISHER = address(0xCAFE);
    address private constant IDENTITY_REGISTRY = address(0x1111);
    address private constant WALLET = address(0x4444);
    string private constant URI = "r2://mandate-evidence/trial-0001.json";
    string private constant DISCLOSURE_URI = "r2://mandate/granted-authority-0001.json";
    uint64 private constant VALID_FROM = 1_790_000_000;
    uint64 private constant VALID_UNTIL = 1_790_086_400;

    function setUp() public {
        registry = new MandateReceiptRegistry();
    }

    function _receipt(bool passed) private pure returns (IMandateReceiptRegistry.Receipt memory) {
        return IMandateReceiptRegistry.Receipt({
            identityRegistry: IDENTITY_REGISTRY,
            agentId: 18433,
            agentVersionHash: keccak256("agent-version-1"),
            trialSpecHash: keccak256("trial-spec-1"),
            testedAuthorityHash: keccak256("tested-authority-1"),
            scenarioHash: keccak256("scenario-1"),
            evaluatorHash: keccak256("evaluator-1"),
            referenceModelHash: keccak256("reference-model-1"),
            evidenceHash: keccak256("evidence-1"),
            snapshotBlock: 40_000_000,
            createdAt: 1_790_000_000,
            freshUntil: 1_790_604_800,
            passed: passed
        });
    }

    function _publish(bool passed) private returns (bytes32) {
        vm.prank(PUBLISHER);
        return registry.publishReceipt(_receipt(passed), URI);
    }

    // --- publication ---------------------------------------------------------

    function test_publishReceipt_storesEveryFieldVerbatim() public {
        bytes32 id = _publish(true);

        IMandateReceiptRegistry.StoredReceipt memory stored = registry.getReceipt(id);

        assertEq(stored.publisher, PUBLISHER);
        assertEq(stored.evidenceURI, URI);
        assertEq(stored.receipt.agentId, 18433);
        assertEq(stored.receipt.testedAuthorityHash, keccak256("tested-authority-1"));
        assertTrue(stored.receipt.passed);
        assertEq(stored.publishedAt, uint64(block.timestamp));
    }

    function test_publishReceipt_returnsTheIdItCommittedTo() public {
        bytes32 id = _publish(true);
        assertEq(id, registry.computeReceiptId(_receipt(true), PUBLISHER, URI));
    }

    function test_publishReceipt_emitsEveryFieldAnIndexerNeeds() public {
        bytes32 expected = registry.computeReceiptId(_receipt(true), PUBLISHER, URI);

        vm.expectEmit(true, true, true, true);
        emit IMandateReceiptRegistry.ReceiptPublished(
            expected,
            PUBLISHER,
            IDENTITY_REGISTRY,
            18433,
            keccak256("agent-version-1"),
            keccak256("trial-spec-1"),
            keccak256("tested-authority-1"),
            keccak256("evidence-1"),
            true,
            URI
        );

        vm.prank(PUBLISHER);
        registry.publishReceipt(_receipt(true), URI);
    }

    function test_publishReceipt_recordsFailingTrialsToo() public {
        bytes32 id = _publish(false);
        assertFalse(registry.getReceipt(id).receipt.passed);
    }

    function test_publishReceipt_countsAndEnumerates() public {
        bytes32 first = _publish(true);
        vm.prank(OTHER_PUBLISHER);
        bytes32 second = registry.publishReceipt(_receipt(true), URI);

        assertEq(registry.receiptCount(), 2);
        assertEq(registry.receiptIdAt(0), first);
        assertEq(registry.receiptIdAt(1), second);
    }

    // --- append-only ---------------------------------------------------------

    function test_publishReceipt_revertsOnRepublication() public {
        bytes32 id = _publish(true);

        vm.prank(PUBLISHER);
        vm.expectRevert(abi.encodeWithSelector(IMandateReceiptRegistry.ReceiptAlreadyPublished.selector, id));
        registry.publishReceipt(_receipt(true), URI);
    }

    /// @notice A second publisher may commit to the same content under its own id.
    /// @dev Attribution is per-publisher, so this is not a duplicate.
    function test_publishReceipt_allowsADifferentPublisherToRestateTheSameContent() public {
        bytes32 first = _publish(true);

        vm.prank(OTHER_PUBLISHER);
        bytes32 second = registry.publishReceipt(_receipt(true), URI);

        assertTrue(first != second);
        assertEq(registry.getReceipt(second).publisher, OTHER_PUBLISHER);
    }

    /// @notice A published receipt cannot be altered by any later call.
    function test_publishReceipt_isImmutableOnceWritten() public {
        bytes32 id = _publish(true);
        bytes32 before = keccak256(abi.encode(registry.getReceipt(id)));

        // Publish an unrelated receipt and record an activation against the first.
        IMandateReceiptRegistry.Receipt memory other = _receipt(true);
        other.agentId = 99;
        vm.prank(PUBLISHER);
        registry.publishReceipt(other, URI);
        vm.prank(WALLET);
        registry.recordActivation(id, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL);

        assertEq(keccak256(abi.encode(registry.getReceipt(id))), before, "stored receipt changed");
    }

    // --- validation ----------------------------------------------------------

    function test_publishReceipt_rejectsAZeroIdentityRegistry() public {
        IMandateReceiptRegistry.Receipt memory receipt = _receipt(true);
        receipt.identityRegistry = address(0);

        vm.prank(PUBLISHER);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.InvalidReceiptField.selector, "identityRegistry")
        );
        registry.publishReceipt(receipt, URI);
    }

    function test_publishReceipt_rejectsAnEmptyEvidenceHash() public {
        IMandateReceiptRegistry.Receipt memory receipt = _receipt(true);
        receipt.evidenceHash = bytes32(0);

        vm.prank(PUBLISHER);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.InvalidReceiptField.selector, "evidenceHash")
        );
        registry.publishReceipt(receipt, URI);
    }

    function test_publishReceipt_rejectsAReceiptStaleOnArrival() public {
        IMandateReceiptRegistry.Receipt memory receipt = _receipt(true);
        receipt.freshUntil = receipt.createdAt;

        vm.prank(PUBLISHER);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.InvalidReceiptField.selector, "freshUntil")
        );
        registry.publishReceipt(receipt, URI);
    }

    function test_publishReceipt_rejectsAnEmptyEvidenceURI() public {
        vm.prank(PUBLISHER);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.InvalidReceiptField.selector, "evidenceURI")
        );
        registry.publishReceipt(_receipt(true), "");
    }

    function test_publishReceipt_rejectsAnOversizedEvidenceURI() public {
        string memory long = new string(513);

        vm.prank(PUBLISHER);
        vm.expectRevert(abi.encodeWithSelector(IMandateReceiptRegistry.EvidenceURITooLong.selector, 513));
        registry.publishReceipt(_receipt(true), long);
    }

    function test_getReceipt_revertsForAnUnknownId() public {
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.UnknownReceipt.selector, bytes32(uint256(1)))
        );
        registry.getReceipt(bytes32(uint256(1)));
    }

    // --- activation ----------------------------------------------------------

    function test_recordActivation_linksAMandateToItsPassingReceipt() public {
        bytes32 receiptId = _publish(true);

        vm.prank(WALLET);
        bytes32 mandateId =
            registry.recordActivation(receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL);

        IMandateReceiptRegistry.Activation memory activation = registry.getActivation(mandateId);
        assertEq(activation.trialReceiptId, receiptId);
        assertEq(activation.wallet, WALLET);
        assertEq(activation.grantedAuthorityHash, keccak256("granted"));
        assertEq(activation.attestedBy, WALLET);
    }

    /// @notice The core falsifiable claim, enforced on-chain rather than in app code.
    function test_recordActivation_revertsWhenTheTrialFailed() public {
        bytes32 receiptId = _publish(false);

        vm.prank(WALLET);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.ReceiptDidNotPass.selector, receiptId)
        );
        registry.recordActivation(receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL);
    }

    function test_recordActivation_revertsForAnUnknownReceipt() public {
        bytes32 missing = keccak256("nope");

        vm.expectRevert(abi.encodeWithSelector(IMandateReceiptRegistry.UnknownReceipt.selector, missing));
        registry.recordActivation(missing, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL);
    }

    function test_recordActivation_revertsOnDuplicateActivation() public {
        bytes32 receiptId = _publish(true);

        vm.startPrank(WALLET);
        bytes32 mandateId =
            registry.recordActivation(receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL);

        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.MandateAlreadyActivated.selector, mandateId)
        );
        registry.recordActivation(receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL);
        vm.stopPrank();
    }

    /// @notice A renewal is a new record, not a mutation of the previous one.
    function test_recordActivation_separatesRenewalsBySequence() public {
        bytes32 receiptId = _publish(true);

        vm.startPrank(WALLET);
        bytes32 first =
            registry.recordActivation(receiptId, WALLET, keccak256("session-1"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL);
        bytes32 second =
            registry.recordActivation(receiptId, WALLET, keccak256("session-2"), keccak256("granted"), 1, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL);
        vm.stopPrank();

        assertTrue(first != second);
        assertEq(registry.getActivation(first).sessionKeyHash, keccak256("session-1"));
        assertEq(registry.getActivation(second).sessionKeyHash, keccak256("session-2"));
    }

    /// @notice A judge with only chain access must be able to OBTAIN the granted
    ///         authority, not merely check one they were handed.
    /// @dev Without a disclosure URI the hash commits to a document that exists
    ///      only in MANDATE's database, so the subset relation becomes
    ///      unverifiable from chain alone.
    function test_recordActivation_storesAndEmitsTheDisclosureURI() public {
        bytes32 receiptId = _publish(true);

        vm.prank(WALLET);
        bytes32 mandateId = registry.recordActivation(
            receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL
        );

        assertEq(registry.getActivation(mandateId).disclosureURI, DISCLOSURE_URI);
    }

    function test_recordActivation_rejectsAnEmptyDisclosureURI() public {
        bytes32 receiptId = _publish(true);

        vm.prank(WALLET);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.InvalidReceiptField.selector, "disclosureURI")
        );
        registry.recordActivation(receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, "", VALID_FROM, VALID_UNTIL);
    }

    function test_recordActivation_rejectsAnOversizedDisclosureURI() public {
        bytes32 receiptId = _publish(true);
        string memory long = new string(513);

        vm.prank(WALLET);
        vm.expectRevert(abi.encodeWithSelector(IMandateReceiptRegistry.EvidenceURITooLong.selector, 513));
        registry.recordActivation(receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, long, VALID_FROM, VALID_UNTIL);
    }

    /// @notice The disclosure URI is not part of the mandate identity.
    /// @dev The hash is what is trusted; the URI only says where the bytes live.
    ///      Binding it into the id would give the same mandate a different
    ///      identity per mirror.
    function test_recordActivation_mandateIdIgnoresTheDisclosureURI() public {
        bytes32 receiptId = _publish(true);

        bytes32 expected = ScopeHashLib.mandateId(
            block.chainid, WALLET, receiptId, keccak256("granted"), 0
        );

        vm.prank(WALLET);
        bytes32 mandateId = registry.recordActivation(
            receiptId,
            WALLET,
            keccak256("session"),
            keccak256("granted"),
            0,
            "ipfs://a-different-mirror",
            VALID_FROM,
            VALID_UNTIL
        );

        assertEq(mandateId, expected);
    }

    function test_recordActivation_rejectsAZeroGrantedAuthorityHash() public {
        bytes32 receiptId = _publish(true);

        vm.prank(WALLET);
        vm.expectRevert(
            abi.encodeWithSelector(
                IMandateReceiptRegistry.InvalidReceiptField.selector, "grantedAuthorityHash"
            )
        );
        registry.recordActivation(receiptId, WALLET, keccak256("session"), bytes32(0), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL);
    }

    // --- fuzz ----------------------------------------------------------------

    function testFuzz_publishReceipt_isDeterministicForAnyContent(
        IMandateReceiptRegistry.Receipt memory receipt,
        address publisher,
        string memory uri
    ) public {
        receipt.identityRegistry = address(uint160(bound(uint160(receipt.identityRegistry), 1, type(uint160).max)));
        receipt.agentVersionHash = keccak256(abi.encode(receipt.agentVersionHash, uint256(1)));
        receipt.trialSpecHash = keccak256(abi.encode(receipt.trialSpecHash, uint256(2)));
        receipt.testedAuthorityHash = keccak256(abi.encode(receipt.testedAuthorityHash, uint256(3)));
        receipt.evidenceHash = keccak256(abi.encode(receipt.evidenceHash, uint256(4)));
        receipt.createdAt = uint64(bound(receipt.createdAt, 1, type(uint64).max - 1));
        receipt.freshUntil = uint64(bound(receipt.freshUntil, uint256(receipt.createdAt) + 1, type(uint64).max));
        vm.assume(bytes(uri).length > 0 && bytes(uri).length <= 512);
        vm.assume(publisher != address(0));

        bytes32 predicted = registry.computeReceiptId(receipt, publisher, uri);

        vm.prank(publisher);
        bytes32 actual = registry.publishReceipt(receipt, uri);

        assertEq(actual, predicted, "published id differs from the predicted one");
        assertTrue(registry.receiptExists(actual));
    }

    /// @notice The registry never custodies value, so a compromise of it cannot
    ///         move anyone's money. It declares no `receive` or `fallback`, which
    ///         makes a plain transfer revert rather than accumulate a balance.
    function testFuzz_registry_holdsNoValue(uint96 amount) public {
        vm.deal(address(this), amount);

        (bool sent,) = address(registry).call{value: amount}("");

        assertFalse(sent, "registry accepted a plain transfer");
        assertEq(address(registry).balance, 0, "registry holds a balance");
    }
    // --- lifecycle -----------------------------------------------------------

    /// @notice The window is what makes a grant reconstructible after revocation.
    /// @dev Once revoked, the account holds no key, so without this record
    ///      "revoked since activation" and "never granted" look identical to
    ///      anyone without archive state.
    function test_recordActivation_commitsTheValidityWindow() public {
        bytes32 receiptId = _publish(true);

        vm.prank(WALLET);
        bytes32 mandateId = registry.recordActivation(
            receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL
        );

        IMandateReceiptRegistry.Activation memory a = registry.getActivation(mandateId);
        assertEq(a.validFrom, VALID_FROM);
        assertEq(a.validUntil, VALID_UNTIL);
        assertEq(a.revokedAt, 0, "a fresh activation is not revoked");
    }

    function test_recordActivation_rejectsAWindowThatEndsBeforeItStarts() public {
        bytes32 receiptId = _publish(true);

        vm.prank(WALLET);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.InvalidReceiptField.selector, "validUntil")
        );
        registry.recordActivation(
            receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_UNTIL, VALID_FROM
        );
    }

    function test_recordRevocation_stampsTheRevocation() public {
        bytes32 mandateId = _activate();

        vm.warp(VALID_FROM + 100);
        vm.prank(WALLET);
        registry.recordRevocation(mandateId);

        assertEq(registry.getActivation(mandateId).revokedAt, uint64(block.timestamp));
    }

    function test_recordRevocation_emitsForIndexers() public {
        bytes32 mandateId = _activate();

        vm.expectEmit(true, true, true, true);
        emit IMandateReceiptRegistry.MandateRevoked(mandateId, WALLET, uint64(block.timestamp));

        vm.prank(WALLET);
        registry.recordRevocation(mandateId);
    }

    /// @notice A stranger cannot make a live mandate look dead.
    function test_recordRevocation_revertsForAnyoneButTheAttestor() public {
        bytes32 mandateId = _activate();

        vm.prank(OTHER_PUBLISHER);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.NotTheAttestor.selector, mandateId, WALLET)
        );
        registry.recordRevocation(mandateId);
    }

    function test_recordRevocation_revertsOnDoubleRevocation() public {
        bytes32 mandateId = _activate();

        vm.startPrank(WALLET);
        registry.recordRevocation(mandateId);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.MandateAlreadyRevoked.selector, mandateId)
        );
        registry.recordRevocation(mandateId);
        vm.stopPrank();
    }

    function test_recordRevocation_revertsForAnUnactivatedMandate() public {
        bytes32 missing = keccak256("never-activated");

        vm.expectRevert(
            abi.encodeWithSelector(IMandateReceiptRegistry.MandateNotActivated.selector, missing)
        );
        registry.recordRevocation(missing);
    }

    /// @notice Revocation stamps a time and never erases the grant it followed.
    function test_recordRevocation_leavesTheGrantReconstructible() public {
        bytes32 mandateId = _activate();

        vm.prank(WALLET);
        registry.recordRevocation(mandateId);

        IMandateReceiptRegistry.Activation memory a = registry.getActivation(mandateId);
        assertEq(a.grantedAuthorityHash, keccak256("granted"));
        assertEq(a.disclosureURI, DISCLOSURE_URI);
        assertEq(a.validFrom, VALID_FROM);
        assertTrue(a.revokedAt != 0);
    }

    function _activate() private returns (bytes32) {
        bytes32 receiptId = _publish(true);
        vm.prank(WALLET);
        return registry.recordActivation(
            receiptId, WALLET, keccak256("session"), keccak256("granted"), 0, DISCLOSURE_URI, VALID_FROM, VALID_UNTIL
        );
    }

}

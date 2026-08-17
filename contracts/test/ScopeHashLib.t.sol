// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ScopeHashLib} from "../src/ScopeHashLib.sol";

/// @notice Phase 0's completion gate: one fixture must hash identically in
///         TypeScript and in Solidity.
/// @dev The expected values in `fixtures/golden-ids.json` are produced by
///      `packages/domain/scripts/emit-golden-fixtures.ts` using
///      `packages/domain/src/ids.ts`. If either implementation drifts, this test
///      fails, which is the point: a receipt id nobody else can reproduce is not
///      a public commitment to anything.
///
///      Fields are read individually rather than through `vm.parseJson` into a
///      struct, because struct decoding depends on alphabetical field ordering
///      and would break silently when a field is renamed.
contract ScopeHashLibTest is Test {
    string private _json;

    function setUp() public {
        _json = vm.readFile("fixtures/golden-ids.json");
    }

    function test_receiptId_matchesTypeScript() public view {
        ScopeHashLib.ReceiptIdInput memory input = _loadReceiptIdInput();

        bytes32 expected = vm.parseJsonBytes32(_json, ".expectedReceiptId");

        assertEq(ScopeHashLib.receiptId(input), expected, "receipt id diverged from TypeScript");
    }

    function test_mandateId_matchesTypeScript() public view {
        bytes32 actual = ScopeHashLib.mandateId(
            vm.parseJsonUint(_json, ".chainId"),
            vm.parseJsonAddress(_json, ".mandate.wallet"),
            vm.parseJsonBytes32(_json, ".mandate.trialReceiptId"),
            vm.parseJsonBytes32(_json, ".mandate.grantedAuthorityHash"),
            uint32(vm.parseJsonUint(_json, ".mandate.sequence"))
        );

        assertEq(actual, vm.parseJsonBytes32(_json, ".expectedMandateId"), "mandate id diverged");
    }

    function test_domainSeparators_matchTheirLabels() public pure {
        assertEq(ScopeHashLib.RECEIPT_ID_DOMAIN, keccak256("mandate.receipt-id/1"));
        assertEq(ScopeHashLib.MANDATE_ID_DOMAIN, keccak256("mandate.mandate-id/1"));
        assertTrue(ScopeHashLib.RECEIPT_ID_DOMAIN != ScopeHashLib.MANDATE_ID_DOMAIN);
    }

    /// @notice Changing any single field must change the identifier.
    function testFuzz_receiptId_isSensitiveToEveryField(uint8 fieldIndex, bytes32 mutation) public view {
        ScopeHashLib.ReceiptIdInput memory input = _loadReceiptIdInput();
        bytes32 before = ScopeHashLib.receiptId(input);

        uint8 field = fieldIndex % 16;
        vm.assume(mutation != bytes32(0));

        if (field == 0) input.chainId = uint256(mutation);
        else if (field == 1) input.publisher = address(uint160(uint256(mutation)));
        else if (field == 2) input.identityRegistry = address(uint160(uint256(mutation)));
        else if (field == 3) input.agentId = uint256(mutation);
        else if (field == 4) input.agentVersionHash = mutation;
        else if (field == 5) input.trialSpecHash = mutation;
        else if (field == 6) input.testedAuthorityHash = mutation;
        else if (field == 7) input.scenarioHash = mutation;
        else if (field == 8) input.evaluatorHash = mutation;
        else if (field == 9) input.referenceModelHash = mutation;
        else if (field == 10) input.evidenceHash = mutation;
        else if (field == 11) input.snapshotBlock = uint64(uint256(mutation));
        else if (field == 12) input.createdAt = uint64(uint256(mutation));
        else if (field == 13) input.freshUntil = uint64(uint256(mutation));
        else if (field == 14) input.passed = !input.passed;
        else input.evidenceURIHash = mutation;

        bytes32 mutated = ScopeHashLib.receiptId(input);

        // A mutation that happens to reproduce the original value is not a collision.
        if (mutated == before) {
            assertTrue(_isUnchanged(field, input), "identifier ignored a changed field");
        }
    }

    /// @notice Two publishers committing identical content get distinct identifiers.
    function testFuzz_receiptId_bindsToPublisher(address publisherA, address publisherB) public view {
        vm.assume(publisherA != publisherB);

        ScopeHashLib.ReceiptIdInput memory input = _loadReceiptIdInput();
        input.publisher = publisherA;
        bytes32 idA = ScopeHashLib.receiptId(input);
        input.publisher = publisherB;

        assertTrue(idA != ScopeHashLib.receiptId(input), "receipt id ignored the publisher");
    }

    /// @notice The same receipt on another chain is a different receipt.
    function testFuzz_receiptId_bindsToChain(uint64 chainA, uint64 chainB) public view {
        vm.assume(chainA != chainB);

        ScopeHashLib.ReceiptIdInput memory input = _loadReceiptIdInput();
        input.chainId = chainA;
        bytes32 idA = ScopeHashLib.receiptId(input);
        input.chainId = chainB;

        assertTrue(idA != ScopeHashLib.receiptId(input), "receipt id ignored the chain");
    }

    function _loadReceiptIdInput() private view returns (ScopeHashLib.ReceiptIdInput memory) {
        return ScopeHashLib.ReceiptIdInput({
            chainId: vm.parseJsonUint(_json, ".chainId"),
            publisher: vm.parseJsonAddress(_json, ".publisher"),
            identityRegistry: vm.parseJsonAddress(_json, ".receipt.identityRegistry"),
            agentId: vm.parseJsonUint(_json, ".receipt.agentId"),
            agentVersionHash: vm.parseJsonBytes32(_json, ".receipt.agentVersionHash"),
            trialSpecHash: vm.parseJsonBytes32(_json, ".receipt.trialSpecHash"),
            testedAuthorityHash: vm.parseJsonBytes32(_json, ".receipt.testedAuthorityHash"),
            scenarioHash: vm.parseJsonBytes32(_json, ".receipt.scenarioHash"),
            evaluatorHash: vm.parseJsonBytes32(_json, ".receipt.evaluatorHash"),
            referenceModelHash: vm.parseJsonBytes32(_json, ".receipt.referenceModelHash"),
            evidenceHash: vm.parseJsonBytes32(_json, ".receipt.evidenceHash"),
            snapshotBlock: uint64(vm.parseJsonUint(_json, ".receipt.snapshotBlock")),
            createdAt: uint64(vm.parseJsonUint(_json, ".receipt.createdAt")),
            freshUntil: uint64(vm.parseJsonUint(_json, ".receipt.freshUntil")),
            passed: vm.parseJsonBool(_json, ".receipt.passed"),
            evidenceURIHash: keccak256(bytes(vm.parseJsonString(_json, ".evidenceURI")))
        });
    }

    /// @dev True when the fuzzer's mutation left the field at its original value,
    ///      e.g. a bytes32 truncated into a uint64 that already matched.
    function _isUnchanged(uint8 field, ScopeHashLib.ReceiptIdInput memory input)
        private
        view
        returns (bool)
    {
        ScopeHashLib.ReceiptIdInput memory original = _loadReceiptIdInput();
        if (field == 0) return input.chainId == original.chainId;
        if (field == 1) return input.publisher == original.publisher;
        if (field == 2) return input.identityRegistry == original.identityRegistry;
        if (field == 3) return input.agentId == original.agentId;
        if (field == 4) return input.agentVersionHash == original.agentVersionHash;
        if (field == 5) return input.trialSpecHash == original.trialSpecHash;
        if (field == 6) return input.testedAuthorityHash == original.testedAuthorityHash;
        if (field == 7) return input.scenarioHash == original.scenarioHash;
        if (field == 8) return input.evaluatorHash == original.evaluatorHash;
        if (field == 9) return input.referenceModelHash == original.referenceModelHash;
        if (field == 10) return input.evidenceHash == original.evidenceHash;
        if (field == 11) return input.snapshotBlock == original.snapshotBlock;
        if (field == 12) return input.createdAt == original.createdAt;
        if (field == 13) return input.freshUntil == original.freshUntil;
        if (field == 14) return false; // `passed` is negated, so it always changes.
        return input.evidenceURIHash == original.evidenceURIHash;
    }
}

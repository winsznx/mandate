// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IMandateReceiptRegistry} from "../src/IMandateReceiptRegistry.sol";
import {MandateReceiptRegistry} from "../src/MandateReceiptRegistry.sol";
import {ScopeHashLib} from "../src/ScopeHashLib.sol";

/// @title DeployBase
/// @notice Shared deployment body for `MandateReceiptRegistry`.
///
/// @dev The registry takes no constructor arguments and has no owner, so
///      deployment is a single `CREATE`. What earns a script is everything
///      around it.
///
///      The chain id is asserted rather than passed, because the one mistake
///      that cannot be undone here is deploying the mainnet registry to testnet
///      or the reverse: receipt ids commit to `block.chainid`, so a registry on
///      the wrong chain silently produces identifiers no verifier will
///      reproduce. A concrete script is therefore bound to exactly one chain.
///
///      No private key is read from the environment. The broadcast picks up
///      whatever sender the CLI supplies (`--private-key`, `--account`,
///      `--ledger`), which keeps key handling outside the repository.
///
///      Verification uses Sourcify, not Etherscan. `api.bscscan.com` V1 is dead
///      and the Etherscan V2 endpoint is paid-tier for BSC, so the free path is
///      the one that has to work:
///
///          forge verify-contract <address> \
///            src/MandateReceiptRegistry.sol:MandateReceiptRegistry \
///            --chain-id <97|56> --verifier sourcify
///
///      After broadcasting, `script/record-deployment.mjs <chainId>` turns the
///      broadcast log into `deployments/<chainId>.json`. That step is separate
///      because the transaction hash only exists once the transaction is mined,
///      which is after this script has returned.
abstract contract DeployBase is Script {
    /// @dev The only chain this concrete script may run against.
    function expectedChainId() public pure virtual returns (uint256);

    /// @dev Human label used in the deployment log.
    function networkName() public pure virtual returns (string memory);

    function run() external returns (MandateReceiptRegistry registry) {
        uint256 expected = expectedChainId();
        require(block.chainid == expected, "DeployBase: wrong chain for this script");

        vm.startBroadcast();
        registry = new MandateReceiptRegistry();
        vm.stopBroadcast();

        _assertUsable(registry);

        console2.log("network        ", networkName());
        console2.log("chainId        ", block.chainid);
        console2.log("registry       ", address(registry));
        console2.log("deployer       ", msg.sender);
        console2.log("block          ", block.number);
        console2.log("");
        console2.log("Next:");
        console2.log("  node script/record-deployment.mjs", block.chainid);
        console2.log("  forge verify-contract <address> \\");
        console2.log("    src/MandateReceiptRegistry.sol:MandateReceiptRegistry \\");
        console2.log("    --chain-id <id> --verifier sourcify");
    }

    /// @dev Post-deployment checks that a mistyped constant or a mismatched
    ///      compiler would trip, run against the freshly deployed bytecode
    ///      rather than against the source that was supposed to produce it.
    function _assertUsable(MandateReceiptRegistry registry) private view {
        require(address(registry).code.length > 0, "DeployBase: no code at the deployed address");
        require(registry.receiptCount() == 0, "DeployBase: registry did not start empty");
        require(registry.MAX_EVIDENCE_URI_LENGTH() == 512, "DeployBase: unexpected URI bound");

        // The deployed contract must derive receipt ids exactly as the shared
        // library does on this chain. A divergence here means every id it hands
        // out is unreproducible off-chain, which is worse than a failed deploy.
        IMandateReceiptRegistry.Receipt memory probe = IMandateReceiptRegistry.Receipt({
            identityRegistry: address(0x1111),
            agentId: 1,
            agentVersionHash: keccak256("probe.agent-version"),
            trialSpecHash: keccak256("probe.trial-spec"),
            testedAuthorityHash: keccak256("probe.tested-authority"),
            scenarioHash: keccak256("probe.scenario"),
            evaluatorHash: keccak256("probe.evaluator"),
            referenceModelHash: keccak256("probe.reference-model"),
            evidenceHash: keccak256("probe.evidence"),
            snapshotBlock: 1,
            createdAt: 1,
            freshUntil: 2,
            passed: true
        });
        string memory probeURI = "probe://deploy-check";

        bytes32 fromChain = registry.computeReceiptId(probe, msg.sender, probeURI);
        bytes32 fromLibrary = ScopeHashLib.receiptId(
            ScopeHashLib.ReceiptIdInput({
                chainId: block.chainid,
                publisher: msg.sender,
                identityRegistry: probe.identityRegistry,
                agentId: probe.agentId,
                agentVersionHash: probe.agentVersionHash,
                trialSpecHash: probe.trialSpecHash,
                testedAuthorityHash: probe.testedAuthorityHash,
                scenarioHash: probe.scenarioHash,
                evaluatorHash: probe.evaluatorHash,
                referenceModelHash: probe.referenceModelHash,
                evidenceHash: probe.evidenceHash,
                snapshotBlock: probe.snapshotBlock,
                createdAt: probe.createdAt,
                freshUntil: probe.freshUntil,
                passed: probe.passed,
                evidenceURIHash: keccak256(bytes(probeURI))
            })
        );

        require(fromChain == fromLibrary, "DeployBase: deployed id derivation diverged");
    }
}

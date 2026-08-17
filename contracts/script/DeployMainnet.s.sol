// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";

/// @notice Deploy `MandateReceiptRegistry` to BSC mainnet (56).
///
/// @dev Usage:
///
///          forge script script/DeployMainnet.s.sol \
///            --rpc-url https://bsc-rpc.publicnode.com \
///            --account <keystore-account> --broadcast
///
///      then record and verify:
///
///          node script/record-deployment.mjs 56
///          forge verify-contract <address> \
///            src/MandateReceiptRegistry.sol:MandateReceiptRegistry \
///            --chain-id 56 --verifier sourcify
///
///      Deploy here only after the testnet registry has carried a real trial
///      end to end. Receipt ids commit to `block.chainid`, so a mainnet registry
///      shares no identifiers with the testnet one and the two records never
///      merge.
contract DeployMainnet is DeployBase {
    function expectedChainId() public pure override returns (uint256) {
        return 56;
    }

    function networkName() public pure override returns (string memory) {
        return "BSC Mainnet";
    }
}

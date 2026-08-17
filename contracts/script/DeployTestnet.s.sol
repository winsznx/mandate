// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";

/// @notice Deploy `MandateReceiptRegistry` to BSC testnet (97).
///
/// @dev Usage:
///
///          forge script script/DeployTestnet.s.sol \
///            --rpc-url https://bsc-testnet-rpc.publicnode.com \
///            --account <keystore-account> --broadcast
///
///      then record and verify:
///
///          node script/record-deployment.mjs 97
///          forge verify-contract <address> \
///            src/MandateReceiptRegistry.sol:MandateReceiptRegistry \
///            --chain-id 97 --verifier sourcify
///
///      Funding: the deployment costs well under 0.01 tBNB at BSC's 0.05 gwei.
///      The official faucet gives 0.3 tBNB per 24h but requires 0.002 BNB on
///      mainnet before it will dispense.
contract DeployTestnet is DeployBase {
    function expectedChainId() public pure override returns (uint256) {
        return 97;
    }

    function networkName() public pure override returns (string memory) {
        return "BSC Testnet";
    }
}

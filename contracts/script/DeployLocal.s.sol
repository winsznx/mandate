// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {DeployBase} from "./DeployBase.sol";

/// @notice Deploy `MandateReceiptRegistry` to a local Anvil node (31337).
///
/// @dev Exists so the whole publication path — deploy, record, publish a
///      receipt, verify it — can be exercised without a funded key. The
///      verifier's end-to-end suite runs this script against `anvil`, which is
///      what keeps the testnet and mainnet scripts from being untested code
///      that only executes the one time it matters.
///
///      A 31337 deployment is not a record of anything public, so its
///      `deployments/` entry is written to a scratch path rather than into the
///      repository.
contract DeployLocal is DeployBase {
    function expectedChainId() public pure override returns (uint256) {
        return 31337;
    }

    function networkName() public pure override returns (string memory) {
        return "Anvil (local)";
    }
}

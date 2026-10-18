// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice Testnet-only, unrestricted faucet token. Never deploy or use for real funds.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Test faucet. Minting is limited to Base Sepolia and local Hardhat chain IDs.
    function mint(address to, uint256 amount) external {
        require(block.chainid == 84532 || block.chainid == 31337, "MockUSDC: testnet only");
        _mint(to, amount);
    }
}

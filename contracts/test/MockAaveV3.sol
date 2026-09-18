// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {
    IAaveV3FlashLoanSimpleReceiver,
    IAaveV3Pool,
    IAaveV3PoolAddressesProvider
} from "../interfaces/IAaveV3.sol";

contract MockAaveV3Pool is IAaveV3Pool {
    using SafeERC20 for IERC20;

    uint128 public immutable override FLASHLOAN_PREMIUM_TOTAL;

    constructor(uint128 premiumBps) {
        FLASHLOAN_PREMIUM_TOTAL = premiumBps;
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        IERC20 token = IERC20(asset);
        uint256 balanceBefore = token.balanceOf(address(this));
        uint256 premium =
            (amount * uint256(FLASHLOAN_PREMIUM_TOTAL) + 5_000) / 10_000;

        token.safeTransfer(receiverAddress, amount);
        bool success = IAaveV3FlashLoanSimpleReceiver(receiverAddress).executeOperation(
            asset, amount, premium, msg.sender, params
        );
        require(success, "CALLBACK_FAILED");
        token.safeTransferFrom(receiverAddress, address(this), amount + premium);
        require(token.balanceOf(address(this)) >= balanceBefore + premium, "NOT_REPAID");
    }
}

contract MockAaveV3PoolAddressesProvider is IAaveV3PoolAddressesProvider {
    address public immutable pool;

    constructor(address pool_) {
        pool = pool_;
    }

    function getPool() external view returns (address) {
        return pool;
    }
}

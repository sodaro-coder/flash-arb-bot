// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IUniswapV2RouterLike} from "../interfaces/IUniswapV2RouterLike.sol";

contract MockRouter is IUniswapV2RouterLike {
    using SafeERC20 for IERC20;

    struct Rate {
        uint256 numerator;
        uint256 denominator;
    }

    mapping(address tokenIn => mapping(address tokenOut => Rate rate)) public rates;

    function setRate(address tokenIn, address tokenOut, uint256 numerator, uint256 denominator) external {
        require(denominator != 0, "ZERO_DENOMINATOR");
        rates[tokenIn][tokenOut] = Rate(numerator, denominator);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        return _amountsOut(amountIn, path);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "EXPIRED");
        amounts = _amountsOut(amountIn, path);
        uint256 amountOut = amounts[amounts.length - 1];
        require(amountOut >= amountOutMin, "SLIPPAGE");

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[path.length - 1]).safeTransfer(to, amountOut);
    }

    function _amountsOut(uint256 amountIn, address[] calldata path)
        private
        view
        returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "BAD_PATH");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;

        for (uint256 i = 1; i < path.length; ++i) {
            Rate memory rate = rates[path[i - 1]][path[i]];
            require(rate.denominator != 0, "NO_RATE");
            amounts[i] = amounts[i - 1] * rate.numerator / rate.denominator;
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {
    IAaveV3FlashLoanSimpleReceiver,
    IAaveV3Pool,
    IAaveV3PoolAddressesProvider
} from "./interfaces/IAaveV3.sol";
import {IUniswapV2RouterLike} from "./interfaces/IUniswapV2RouterLike.sol";

/// @notice Atomic Aave V3 flash-loan arbitrage across two allowlisted V2-style routers.
/// @dev The off-chain keeper must quote and simulate every request. This contract's job is
///      to make a stale or unprofitable request revert without consuming trading capital.
contract FlashArbitrage is Ownable2Step, IAaveV3FlashLoanSimpleReceiver {
    using SafeERC20 for IERC20;

    struct Route {
        address buyRouter;
        address sellRouter;
        address[] buyPath;
        address[] sellPath;
        uint256 minBuyAmount;
        uint256 minFinalAmount;
        uint256 minProfit;
        uint256 deadline;
    }

    error ActiveLoan();
    error CallbackNotCompleted();
    error EmptyAmount();
    error ExpiredRequest();
    error InsufficientProfit(uint256 actual, uint256 required);
    error InvalidCallback();
    error InvalidPath();
    error InvalidRouter(address router);
    error NativeTransferFailed();
    error NotKeeper();
    error ZeroAddress();

    event ArbitrageExecuted(
        address indexed asset,
        address indexed intermediateToken,
        address indexed caller,
        uint256 borrowedAmount,
        uint256 premium,
        uint256 profit
    );
    event KeeperUpdated(address indexed keeper, bool allowed);
    event RouterUpdated(address indexed router, bool allowed);

    IAaveV3PoolAddressesProvider public immutable addressesProvider;
    IAaveV3Pool public immutable pool;

    mapping(address keeper => bool allowed) public keepers;
    mapping(address router => bool allowed) public routers;

    bytes32 private activeRequestHash;
    address private activeCaller;

    constructor(IAaveV3PoolAddressesProvider provider, address initialOwner) Ownable(initialOwner) {
        if (address(provider) == address(0) || initialOwner == address(0)) revert ZeroAddress();

        address poolAddress = provider.getPool();
        if (poolAddress == address(0)) revert ZeroAddress();

        addressesProvider = provider;
        pool = IAaveV3Pool(poolAddress);
    }

    modifier onlyKeeper() {
        if (msg.sender != owner() && !keepers[msg.sender]) revert NotKeeper();
        _;
    }

    /// @notice Starts one atomic loan and two-swap route.
    /// @dev `minProfit` is denominated in `asset` and should include estimated gas cost.
    function requestArbitrage(address asset, uint256 amount, Route calldata route) external onlyKeeper {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert EmptyAmount();
        if (activeRequestHash != bytes32(0)) revert ActiveLoan();

        _validateRoute(asset, route);

        bytes memory encodedRoute = abi.encode(route);
        activeRequestHash = keccak256(abi.encode(asset, amount, encodedRoute));
        activeCaller = msg.sender;

        pool.flashLoanSimple(address(this), asset, amount, encodedRoute, 0);

        if (activeRequestHash != bytes32(0)) revert CallbackNotCompleted();
    }

    /// @inheritdoc IAaveV3FlashLoanSimpleReceiver
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (
            msg.sender != address(pool) || initiator != address(this)
                || activeRequestHash != keccak256(abi.encode(asset, amount, params))
        ) revert InvalidCallback();

        Route memory route = abi.decode(params, (Route));
        _validateRoute(asset, route);

        // Clear before router calls. A revert restores the active request automatically.
        address caller = activeCaller;
        delete activeRequestHash;
        delete activeCaller;

        IERC20 borrowedToken = IERC20(asset);
        uint256 currentBalance = borrowedToken.balanceOf(address(this));
        if (currentBalance < amount) revert InvalidCallback();
        uint256 startingBalance = currentBalance - amount;

        address intermediateToken = route.buyPath[route.buyPath.length - 1];
        uint256 intermediateAmount = _swap(
            route.buyRouter,
            borrowedToken,
            IERC20(intermediateToken),
            amount,
            route.minBuyAmount,
            route.buyPath,
            route.deadline
        );

        _swap(
            route.sellRouter,
            IERC20(intermediateToken),
            borrowedToken,
            intermediateAmount,
            route.minFinalAmount,
            route.sellPath,
            route.deadline
        );

        uint256 amountOwed = amount + premium;
        uint256 finalBalance = borrowedToken.balanceOf(address(this));
        uint256 requiredBalance = startingBalance + amountOwed + route.minProfit;
        if (finalBalance < requiredBalance) {
            uint256 actualProfit = finalBalance > startingBalance + amountOwed
                ? finalBalance - startingBalance - amountOwed
                : 0;
            revert InsufficientProfit(actualProfit, route.minProfit);
        }

        uint256 profit = finalBalance - startingBalance - amountOwed;
        borrowedToken.forceApprove(address(pool), amountOwed);

        emit ArbitrageExecuted(asset, intermediateToken, caller, amount, premium, profit);

        return true;
    }

    function flashFeeBps() external view returns (uint256) {
        return uint256(pool.FLASHLOAN_PREMIUM_TOTAL());
    }

    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        keepers[keeper] = allowed;
        emit KeeperUpdated(keeper, allowed);
    }

    function setRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        if (allowed && router.code.length == 0) revert InvalidRouter(router);
        routers[router] = allowed;
        emit RouterUpdated(router, allowed);
    }

    function withdrawToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (activeRequestHash != bytes32(0)) revert ActiveLoan();
        token.safeTransfer(to, amount);
    }

    function withdrawNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (activeRequestHash != bytes32(0)) revert ActiveLoan();
        (bool success,) = to.call{value: amount}("");
        if (!success) revert NativeTransferFailed();
    }

    receive() external payable {}

    function _swap(
        address router,
        IERC20 tokenIn,
        IERC20 tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address[] memory path,
        uint256 deadline
    ) private returns (uint256 amountOut) {
        uint256 balanceBefore = tokenOut.balanceOf(address(this));
        tokenIn.forceApprove(router, amountIn);

        IUniswapV2RouterLike(router).swapExactTokensForTokens(
            amountIn, minAmountOut, path, address(this), deadline
        );

        // Never leave a router allowance behind, including routers that consume less than expected.
        tokenIn.forceApprove(router, 0);
        amountOut = tokenOut.balanceOf(address(this)) - balanceBefore;
        if (amountOut < minAmountOut) revert InsufficientProfit(amountOut, minAmountOut);
    }

    function _validateRoute(address asset, Route memory route) private view {
        if (block.timestamp > route.deadline) revert ExpiredRequest();
        if (!routers[route.buyRouter]) revert InvalidRouter(route.buyRouter);
        if (!routers[route.sellRouter]) revert InvalidRouter(route.sellRouter);
        if (route.buyPath.length < 2 || route.sellPath.length < 2) revert InvalidPath();

        address intermediateToken = route.buyPath[route.buyPath.length - 1];
        if (
            route.buyPath[0] != asset || intermediateToken == asset
                || route.sellPath[0] != intermediateToken
                || route.sellPath[route.sellPath.length - 1] != asset
        ) revert InvalidPath();
    }
}

import { parseAbi } from "viem";

export const executorAbi = parseAbi([
  "function flashFeeBps() view returns (uint256)",
  "function requestArbitrage(address asset, uint256 amount, (address buyRouter, address sellRouter, address[] buyPath, address[] sellPath, uint256 minBuyAmount, uint256 minFinalAmount, uint256 minProfit, uint256 deadline) route)",
  "function setKeeper(address keeper, bool allowed)",
  "function setRouter(address router, bool allowed)",
]);

export const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);

export const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

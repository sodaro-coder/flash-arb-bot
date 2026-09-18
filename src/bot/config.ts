import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import "dotenv/config";
import {
  defineChain,
  getAddress,
  isAddress,
  parseEther,
  type Address,
  type Chain,
} from "viem";

export interface RouteConfig {
  name: string;
  enabled: boolean;
  borrowToken: Address;
  buyRouter: Address;
  sellRouter: Address;
  buyPath: Address[];
  sellPath: Address[];
  borrowAmounts: string[];
  bidirectional: boolean;
}

export interface BotConfig {
  rpcUrl: string;
  chain: Chain;
  wrappedNativeToken: Address;
  executorAddress: Address;
  keeperAddress: Address;
  privateKey?: `0x${string}`;
  liveTrading: boolean;
  pollIntervalMs: number;
  slippageBps: bigint;
  gasBufferBps: bigint;
  fixedGasOverhead: bigint;
  maxGasCost: bigint;
  minNetProfit: bigint;
  minWalletReserve: bigint;
  routes: RouteConfig[];
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} must be a valid address`);
  }
  return getAddress(value);
}

function addressPath(value: unknown, label: string): Address[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${label} must contain at least two addresses`);
  }
  return value.map((item, index) => address(item, `${label}[${index}]`));
}

function parseRoute(value: unknown, index: number): RouteConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error(`routes[${index}] must be an object`);
  }
  const route = value as Record<string, unknown>;
  if (route.enabled !== undefined && typeof route.enabled !== "boolean") {
    throw new Error(`routes[${index}].enabled must be a boolean when provided`);
  }
  if (
    route.bidirectional !== undefined &&
    typeof route.bidirectional !== "boolean"
  ) {
    throw new Error(
      `routes[${index}].bidirectional must be a boolean when provided`,
    );
  }
  const buyPath = addressPath(route.buyPath, `routes[${index}].buyPath`);
  const sellPath = addressPath(route.sellPath, `routes[${index}].sellPath`);
  const borrowToken = address(route.borrowToken, `routes[${index}].borrowToken`);

  if (
    buyPath[0] !== borrowToken ||
    buyPath[buyPath.length - 1] === borrowToken ||
    sellPath[0] !== buyPath[buyPath.length - 1] ||
    sellPath[sellPath.length - 1] !== borrowToken
  ) {
    throw new Error(`routes[${index}] paths do not form a closed arbitrage cycle`);
  }
  if (
    !Array.isArray(route.borrowAmounts) ||
    route.borrowAmounts.length === 0 ||
    route.borrowAmounts.some((amount) =>
      typeof amount !== "string" || !/^\d+(\.\d+)?$/.test(amount)
    )
  ) {
    throw new Error(`routes[${index}].borrowAmounts must be decimal strings`);
  }

  return {
    name:
      typeof route.name === "string" && route.name.trim()
        ? route.name.trim()
        : `route-${index + 1}`,
    enabled: route.enabled ?? true,
    borrowToken,
    buyRouter: address(route.buyRouter, `routes[${index}].buyRouter`),
    sellRouter: address(route.sellRouter, `routes[${index}].sellRouter`),
    buyPath,
    sellPath,
    borrowAmounts: route.borrowAmounts as string[],
    bidirectional: route.bidirectional ?? false,
  };
}

export async function loadRoutes(
  routesPath = resolve(process.env.ROUTES_FILE?.trim() || "config/routes.json"),
): Promise<RouteConfig[]> {
  const routesJson: unknown = JSON.parse(await readFile(routesPath, "utf8"));
  if (!Array.isArray(routesJson)) throw new Error("routes file must contain an array");
  const routes = routesJson.map(parseRoute).filter((route) => route.enabled);
  if (routes.length === 0) throw new Error("at least one route must be enabled");
  return routes;
}

export async function loadConfig(): Promise<BotConfig> {
  const pollIntervalMs = envInt("POLL_INTERVAL_MS", 2_500);
  if (pollIntervalMs < 250 || pollIntervalMs > 5_000) {
    throw new Error("POLL_INTERVAL_MS must be between 250 and 5000");
  }

  const chainId = envInt("CHAIN_ID", 8453);
  const rpcUrl = required("RPC_URL");
  const chain = defineChain({
    id: chainId,
    name: process.env.CHAIN_NAME?.trim() || `chain-${chainId}`,
    nativeCurrency: {
      name: process.env.NATIVE_CURRENCY_NAME?.trim() || "Ether",
      symbol: process.env.NATIVE_CURRENCY_SYMBOL?.trim() || "ETH",
      decimals: 18,
    },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const privateKey = process.env.PRIVATE_KEY?.trim() as `0x${string}` | undefined;
  if (privateKey && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("PRIVATE_KEY must be a 32-byte 0x-prefixed hex value");
  }
  const liveTrading = process.env.LIVE_TRADING === "true";
  if (liveTrading && !privateKey) {
    throw new Error("PRIVATE_KEY is required when LIVE_TRADING=true");
  }

  const routes = await loadRoutes();
  const executorAddress = address(required("EXECUTOR_ADDRESS"), "EXECUTOR_ADDRESS");
  const keeperAddress = address(required("KEEPER_ADDRESS"), "KEEPER_ADDRESS");
  const wrappedNativeToken = address(
    required("WRAPPED_NATIVE_TOKEN"),
    "WRAPPED_NATIVE_TOKEN",
  );
  const sentinelAddresses = new Set<Address>([
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000001",
  ]);
  if (
    sentinelAddresses.has(executorAddress) ||
    sentinelAddresses.has(keeperAddress) ||
    sentinelAddresses.has(wrappedNativeToken)
  ) {
    throw new Error(
      "EXECUTOR_ADDRESS, KEEPER_ADDRESS, and WRAPPED_NATIVE_TOKEN must replace the example sentinels",
    );
  }
  if (routes.some((route) => route.borrowToken !== wrappedNativeToken)) {
    throw new Error(
      "every borrowToken must equal WRAPPED_NATIVE_TOKEN so gas and profit use the same unit",
    );
  }

  const fixedGasOverhead = parseEther(
    process.env.FIXED_GAS_OVERHEAD_NATIVE || "0",
  );
  const maxGasCost = parseEther(process.env.MAX_GAS_COST_NATIVE || "0.0005");
  const minNetProfit = parseEther(
    process.env.MIN_NET_PROFIT_NATIVE || "0.00001",
  );
  const minWalletReserve = parseEther(
    process.env.MIN_WALLET_RESERVE_NATIVE || "0.0005",
  );
  if (
    fixedGasOverhead < 0n ||
    maxGasCost < 0n ||
    minNetProfit < 0n ||
    minWalletReserve < 0n
  ) {
    throw new Error("gas and profit limits cannot be negative");
  }
  const slippageBps = BigInt(envInt("SLIPPAGE_BPS", 30));
  const gasBufferBps = BigInt(envInt("GAS_COST_BUFFER_BPS", 15_000));
  if (slippageBps < 0n || slippageBps >= 10_000n) {
    throw new Error("SLIPPAGE_BPS must be between 0 and 9999");
  }
  if (gasBufferBps < 10_000n) {
    throw new Error("GAS_COST_BUFFER_BPS must be at least 10000");
  }

  return {
    rpcUrl,
    chain,
    wrappedNativeToken,
    executorAddress,
    keeperAddress,
    privateKey,
    liveTrading,
    pollIntervalMs,
    slippageBps,
    gasBufferBps,
    fixedGasOverhead,
    maxGasCost,
    minNetProfit,
    minWalletReserve,
    routes,
  };
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { executorAbi } from "../src/bot/abi.js";
import { loadRoutes } from "../src/bot/config.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.env.DEPLOY_CONFIRM !== "I_HAVE_RUN_THE_10_TRADE_SIMULATION") {
  throw new Error(
    "Refusing to deploy. Run `pnpm simulate`, then set DEPLOY_CONFIRM=I_HAVE_RUN_THE_10_TRADE_SIMULATION.",
  );
}

const rpcUrl = required("RPC_URL");
const privateKey = required("PRIVATE_KEY") as Hex;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("invalid PRIVATE_KEY");
const account = privateKeyToAccount(privateKey);
const chainId = Number(required("CHAIN_ID"));
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
const providerAddress = getAddress(required("AAVE_V3_POOL_ADDRESSES_PROVIDER"));
const keeperAddress = getAddress(process.env.KEEPER_ADDRESS?.trim() || account.address);

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
if (!(await publicClient.getBytecode({ address: providerAddress }))) {
  throw new Error("AAVE_V3_POOL_ADDRESSES_PROVIDER has no code on the configured chain");
}

const routesPath = resolve(process.env.ROUTES_FILE?.trim() || "config/routes.json");
const routes = await loadRoutes(routesPath);
const routerAddresses = new Set<Address>();
for (const route of routes) {
  for (const candidate of [route.buyRouter, route.sellRouter]) {
    if (!isAddress(candidate)) throw new Error(`invalid router address: ${candidate}`);
    routerAddresses.add(getAddress(candidate));
  }
}
for (const router of routerAddresses) {
  if (!(await publicClient.getBytecode({ address: router }))) {
    throw new Error(`router has no code on the configured chain: ${router}`);
  }
}

const artifactPath = resolve(
  "artifacts/contracts/FlashArbitrage.sol/FlashArbitrage.json",
);
const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as {
  abi: Abi;
  bytecode: Hex;
};
const deploymentHash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [providerAddress, account.address],
});
const deploymentReceipt = await publicClient.waitForTransactionReceipt({
  hash: deploymentHash,
});
if (deploymentReceipt.status !== "success" || !deploymentReceipt.contractAddress) {
  throw new Error(`deployment failed: ${deploymentHash}`);
}
const executorAddress = deploymentReceipt.contractAddress;

for (const router of routerAddresses) {
  const { request } = await publicClient.simulateContract({
    account,
    address: executorAddress,
    abi: executorAbi,
    functionName: "setRouter",
    args: [router, true],
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`setRouter reverted for ${router}: ${hash}`);
  }
}

if (keeperAddress !== account.address) {
  const { request } = await publicClient.simulateContract({
    account,
    address: executorAddress,
    abi: executorAbi,
    functionName: "setKeeper",
    args: [keeperAddress, true],
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`setKeeper reverted for ${keeperAddress}: ${hash}`);
  }
}

process.stdout.write(
  `Deployed and configured FlashArbitrage at ${executorAddress}\nSet EXECUTOR_ADDRESS=${executorAddress}\n`,
);

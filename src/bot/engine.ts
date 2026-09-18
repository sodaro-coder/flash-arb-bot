import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { erc20Abi, executorAbi, routerAbi } from "./abi.js";
import type { BotConfig, RouteConfig } from "./config.js";
import { assessOpportunity, type OpportunityAssessment } from "./strategy.js";

export type EngineEvent =
  | { type: "cycle"; at: string; routes: number; candidates: number }
  | { type: "candidate"; candidate: Candidate }
  | { type: "trade"; candidate: Candidate; hash: string; blockNumber: string }
  | { type: "skip"; route: string; reason: string }
  | { type: "error"; message: string }
  | { type: "wallet"; balance: string; symbol: string };

export interface Candidate {
  route: string;
  direction: "forward" | "reverse";
  borrowAmount: string;
  expectedGrossProfit: string;
  estimatedGasCost: string;
  estimatedGasCostWei: bigint;
  expectedNetProfit: string;
  expectedNetProfitWei: bigint;
  simulated: boolean;
  request: {
    asset: Address;
    amount: bigint;
    route: {
      buyRouter: Address;
      sellRouter: Address;
      buyPath: Address[];
      sellPath: Address[];
      minBuyAmount: bigint;
      minFinalAmount: bigint;
      minProfit: bigint;
      deadline: bigint;
    };
  };
}

interface DirectionalRoute extends RouteConfig {
  direction: "forward" | "reverse";
}

export class ArbitrageEngine {
  private readonly publicClient: PublicClient;
  private readonly emit: (event: EngineEvent) => void;
  private timer?: NodeJS.Timeout;
  private scanning = false;
  private stopped = true;
  private readonly decimals = new Map<Address, number>();
  private readonly symbols = new Map<Address, string>();

  constructor(
    private readonly config: BotConfig,
    emit: (event: EngineEvent) => void = () => undefined,
  ) {
    this.emit = emit;
    this.publicClient = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl, { retryCount: 0, timeout: 4_000 }),
    });
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.runOnce();
    if (!this.stopped) {
      this.timer = setInterval(() => void this.runOnce(), this.config.pollIntervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<Candidate[]> {
    if (this.scanning) return [];
    this.scanning = true;
    try {
      const [balance, candidates] = await Promise.all([
        this.publicClient.getBalance({ address: this.config.keeperAddress }),
        this.scanAll(),
      ]);
      this.emit({
        type: "wallet",
        balance: formatEther(balance),
        symbol: this.config.chain.nativeCurrency.symbol,
      });
      this.emit({
        type: "cycle",
        at: new Date().toISOString(),
        routes: this.directionalRoutes().length,
        candidates: candidates.length,
      });

      const best = candidates.sort((a, b) =>
        a.expectedNetProfitWei > b.expectedNetProfitWei ? -1 : 1,
      )[0];
      if (best) {
        this.emit({ type: "candidate", candidate: best });
        if (this.config.liveTrading && !this.stopped) {
          await this.execute(best, balance);
        }
      }
      return candidates;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", message });
      return [];
    } finally {
      this.scanning = false;
    }
  }

  private directionalRoutes(): DirectionalRoute[] {
    return this.config.routes.flatMap((route) => {
      const forward: DirectionalRoute = { ...route, direction: "forward" };
      if (!route.bidirectional) return [forward];
      return [
        forward,
        {
          ...route,
          name: `${route.name} (reverse DEX order)`,
          buyRouter: route.sellRouter,
          sellRouter: route.buyRouter,
          direction: "reverse",
        },
      ];
    });
  }

  private async scanAll(): Promise<Candidate[]> {
    const results = await Promise.allSettled(
      this.directionalRoutes().flatMap((route) =>
        route.borrowAmounts.map((amount) =>
          this.withTimeout(
            this.scanAmount(route, amount),
            4_500,
            `${route.name} ${amount}: scan exceeded 4.5 seconds`,
          ),
        ),
      ),
    );

    const candidates: Candidate[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value) candidates.push(result.value);
      } else {
        this.emit({
          type: "error",
          message:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    }
    return candidates;
  }

  private async scanAmount(
    route: DirectionalRoute,
    humanAmount: string,
  ): Promise<Candidate | undefined> {
    const [decimals, symbol, flashFeeBps, fees] = await Promise.all([
      this.tokenDecimals(route.borrowToken),
      this.tokenSymbol(route.borrowToken),
      this.publicClient.readContract({
        address: this.config.executorAddress,
        abi: executorAbi,
        functionName: "flashFeeBps",
      }),
      this.publicClient.estimateFeesPerGas(),
    ]);
    const amount = parseUnits(humanAmount, decimals);
    const firstQuote = await this.quote(route.buyRouter, amount, route.buyPath);
    const finalQuote = await this.quote(
      route.sellRouter,
      firstQuote,
      route.sellPath,
    );

    const premium = (amount * flashFeeBps + 9_999n) / 10_000n;
    if (finalQuote <= amount + premium + this.config.minNetProfit) {
      this.emit({
        type: "skip",
        route: route.name,
        reason: `${humanAmount} ${symbol}: spread below pre-gas profit floor`,
      });
      return undefined;
    }

    const provisionalRoute = {
      buyRouter: route.buyRouter,
      sellRouter: route.sellRouter,
      buyPath: route.buyPath,
      sellPath: route.sellPath,
      minBuyAmount: 1n,
      minFinalAmount: amount + premium + this.config.minNetProfit,
      minProfit: this.config.minNetProfit,
      deadline: BigInt(Math.floor(Date.now() / 1_000) + 60),
    } as const;
    const gasUnits = await this.publicClient.estimateContractGas({
      account: this.config.keeperAddress,
      address: this.config.executorAddress,
      abi: executorAbi,
      functionName: "requestArbitrage",
      args: [route.borrowToken, amount, provisionalRoute],
    });
    const feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    const assessment = assessOpportunity({
      amount,
      firstOut: firstQuote,
      finalOut: finalQuote,
      flashFeeBps,
      gasUnits,
      feePerGas,
      gasBufferBps: this.config.gasBufferBps,
      fixedGasOverhead: this.config.fixedGasOverhead,
      maxGasCost: this.config.maxGasCost,
      minNetProfit: this.config.minNetProfit,
      slippageBps: this.config.slippageBps,
    });
    if (!assessment.executable) {
      this.emit({
        type: "skip",
        route: route.name,
        reason: `${humanAmount} ${symbol}: ${assessment.reason}`,
      });
      return undefined;
    }

    const request = {
      asset: route.borrowToken,
      amount,
      route: {
        ...provisionalRoute,
        minBuyAmount: assessment.minBuyAmount,
        minFinalAmount: assessment.minFinalAmount,
        minProfit: assessment.minProfit,
      },
    };

    // A candidate is never executable until the exact calldata succeeds in eth_call.
    await this.publicClient.simulateContract({
      account: this.config.keeperAddress,
      address: this.config.executorAddress,
      abi: executorAbi,
      functionName: "requestArbitrage",
      args: [request.asset, request.amount, request.route],
    });

    return this.candidate(route, humanAmount, symbol, assessment, decimals, request);
  }

  private candidate(
    route: DirectionalRoute,
    humanAmount: string,
    symbol: string,
    assessment: OpportunityAssessment,
    decimals: number,
    request: Candidate["request"],
  ): Candidate {
    return {
      route: route.name,
      direction: route.direction,
      borrowAmount: `${humanAmount} ${symbol}`,
      expectedGrossProfit: `${formatUnits(assessment.expectedGrossProfit, decimals)} ${symbol}`,
      estimatedGasCost: `${formatEther(assessment.estimatedGasCost)} ${this.config.chain.nativeCurrency.symbol}`,
      estimatedGasCostWei: assessment.estimatedGasCost,
      expectedNetProfit: `${formatUnits(assessment.expectedNetProfit, decimals)} ${symbol}`,
      expectedNetProfitWei: assessment.expectedNetProfit,
      simulated: true,
      request,
    };
  }

  private async execute(candidate: Candidate, walletBalance: bigint): Promise<void> {
    if (!this.config.privateKey) throw new Error("live trading requires PRIVATE_KEY");
    if (
      walletBalance <= this.config.minWalletReserve + candidate.estimatedGasCostWei
    ) {
      throw new Error("wallet balance is below the configured reserve");
    }
    const account = privateKeyToAccount(this.config.privateKey);
    if (account.address !== this.config.keeperAddress) {
      throw new Error("PRIVATE_KEY does not match KEEPER_ADDRESS");
    }
    const walletClient = createWalletClient({
      account,
      chain: this.config.chain,
      transport: http(this.config.rpcUrl, { retryCount: 0, timeout: 4_000 }),
    });
    const simulation = await this.publicClient.simulateContract({
      account,
      address: this.config.executorAddress,
      abi: executorAbi,
      functionName: "requestArbitrage",
      args: [
        candidate.request.asset,
        candidate.request.amount,
        candidate.request.route,
      ],
    });
    // A stop request received during simulation must win the race with broadcast.
    if (this.stopped) return;
    const hash = await walletClient.writeContract(simulation.request);
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash,
      timeout: 120_000,
    });
    if (receipt.status !== "success") throw new Error(`trade reverted: ${hash}`);
    this.emit({
      type: "trade",
      candidate,
      hash,
      blockNumber: receipt.blockNumber.toString(),
    });
  }

  private async quote(
    router: Address,
    amount: bigint,
    path: Address[],
  ): Promise<bigint> {
    const amounts = await this.publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: "getAmountsOut",
      args: [amount, path],
    });
    return amounts.at(-1) ?? 0n;
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async tokenDecimals(token: Address): Promise<number> {
    const cached = this.decimals.get(token);
    if (cached !== undefined) return cached;
    const value = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    });
    this.decimals.set(token, value);
    return value;
  }

  private async tokenSymbol(token: Address): Promise<string> {
    const cached = this.symbols.get(token);
    if (cached !== undefined) return cached;
    const value = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
    });
    this.symbols.set(token, value);
    return value;
  }
}

# Flash Arb Console

A guarded Aave V3 flash-loan arbitrage executor, parallel opportunity scanner, and small local dashboard for low-fee EVM networks.

This is not a guaranteed-profit system. With a $5–10 wallet, the realistic use of funds is transaction gas on a low-fee chain; the borrowed trading principal comes from Aave and is repaid atomically. Competition, stale quotes, MEV, RPC latency, contract risk, and gas can still make live operation unprofitable.

## What changed

The original contracts were incomplete, depended on retired Ropsten/Aave V1-era interfaces, swallowed failed swaps, and could repay a bad trade from deposited funds. They have been replaced by:

- `contracts/FlashArbitrage.sol`: Aave V3 `flashLoanSimple`, multi-hop V2-style routes, router allowlist, owner/keeper separation, exact callback binding, allowance cleanup, two-step ownership, withdrawals, and a profit check that cannot spend the contract's pre-existing balance.
- `src/bot/`: concurrent route/size quoting, conservative flash-fee math, buffered gas accounting, net-profit filtering, exact calldata simulation, and single-best-candidate execution.
- `src/app/`: a lightweight local dashboard that runs on Fedora through Node; it never receives or displays the private key.
- `test/ten-trade-simulation.ts`: ten local contract-level scenarios with nine profitable executions and one adverse route that is rejected atomically.

## Safety model

Every live candidate must pass all of these gates:

1. Both router quotes close the route back into wrapped native gas currency.
2. Expected output repays principal and a conservatively rounded flash fee.
3. Buffered gas cost and the configured minimum net profit fit inside the spread.
4. The exact transaction calldata passes `eth_call` simulation from the keeper account.
5. The contract independently enforces router approval, path closure, deadline, slippage, repayment, and minimum profit.

Only the best expected net candidate is eligible per scan cycle. Parallel workers do not submit concurrent transactions from one wallet. The default is scan-only; live sending requires `LIVE_TRADING=true` and a matching private key.

## Install and validate

Node 24 and pnpm 11 are the tested toolchain.

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm simulate
```

The acceptance command must print `9/10 profitable executions (90%)`, one adverse trade protected, and zero live transactions sent. These are controlled local scenarios, not evidence of a 90% win rate on a live market.

## Preview the Fedora dashboard

The demo is explicitly synthetic and needs no wallet or RPC:

```bash
pnpm app:demo
```

Open `http://127.0.0.1:4173`. For real scan-only data, copy the examples and fill in current chain addresses:

```bash
cp .env.example .env
cp config/routes.example.json config/routes.json
pnpm app
```

The scanner defaults to 2.5-second cycles and refuses intervals above five seconds. Quote workers for all routes, both DEX directions, and all configured borrow sizes run concurrently. Slow RPC calls time out after four seconds.

The **Connect MetaMask** button verifies the selected browser-wallet account and requests the configured EVM chain. It never requests a signature or private key. For unattended trading, export only the dedicated bot account's key into the local `.env`; MetaMask itself intentionally requires interactive approval and cannot auto-sign every opportunity. Never use or export the key for a primary wallet.

## Configure routes

Use only a low-fee Aave V3 network where the wrapped-native asset is flash-loan enabled and both selected exchanges expose a trusted Uniswap V2-compatible router. Obtain provider, token, and router addresses from the protocols' official deployment registries and verify each address on the target chain.

For accurate all-in profit accounting, every route's `borrowToken` must equal `WRAPPED_NATIVE_TOKEN`; this lets the engine compare profit and gas in the same unit. Add intermediate tokens to `buyPath` and reverse them in `sellPath`. `bidirectional: true` scans both router orders. More route objects create more independent workers.

Start with `LIVE_TRADING=false` and inspect scan-only results for a meaningful period. A standard public RPC/public mempool is usually too slow and exposes profitable calldata to copying; use a reputable private-transaction-capable endpoint if the target chain supports it.

## Deploy only after simulation

Create a dedicated wallet, fund it with only the amount you can afford to lose, and keep its private key solely in the untracked `.env`. Build and run the local acceptance simulation before enabling deployment:

```bash
pnpm build
pnpm simulate
DEPLOY_CONFIRM=I_HAVE_RUN_THE_10_TRADE_SIMULATION pnpm deploy
```

The deployment script verifies the Aave provider and routers have bytecode, deploys the executor, allowlists every configured router, and authorizes `KEEPER_ADDRESS`. It prints the value to place in `EXECUTOR_ADDRESS`.

Run at least several days in scan-only mode before considering `LIVE_TRADING=true`. Set `MIN_WALLET_RESERVE_NATIVE` high enough that a transaction can never consume the full gas wallet. Profits remain in the executor until the owner calls `withdrawToken`; monitor and withdraw them deliberately.

## Limits

- The included executor supports V2-style `swapExactTokensForTokens` routers, not Uniswap V3 concentrated-liquidity paths or aggregator calldata.
- Fee-on-transfer and rebasing tokens are intentionally unsupported.
- Gas estimation on L2s can omit part of the L1 data fee; use `FIXED_GAS_OVERHEAD_NATIVE` plus the default 150% buffer and tune from measured receipts.
- Local tests use deterministic mock liquidity. Before real funds, fork the exact target chain at a recent block and perform an independent smart-contract audit.
- This repository does not include sandwiching, front-running, honeypot sniping, or other strategies that depend on harming another trader.

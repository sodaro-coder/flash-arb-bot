import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { parseEther, zeroAddress } from "viem";

describe("ten-trade acceptance simulation", async () => {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();

  it("executes 9 profitable trades and atomically protects the adverse trade", async () => {
    const [owner, keeper, stranger] = await viem.getWalletClients();
    assert(owner && keeper && stranger);

    // Hardhat resolves these local artifact ABIs at runtime; the test runner still
    // executes every call against the compiled contract ABI.
    const borrowed: any = await viem.deployContract("MockERC20", ["Wrapped Native", "WNATIVE"]);
    const intermediate: any = await viem.deployContract("MockERC20", ["Quote", "QUOTE"]);
    const pool: any = await viem.deployContract("MockAaveV3Pool", [5n]);
    const provider: any = await viem.deployContract("MockAaveV3PoolAddressesProvider", [pool.address]);
    const buyRouter: any = await viem.deployContract("MockRouter");
    const sellRouter: any = await viem.deployContract("MockRouter");
    const executor: any = await viem.deployContract("FlashArbitrage", [
      provider.address,
      owner.account.address,
    ]);

    const deepLiquidity = parseEther("1000000");
    await borrowed.write.mint([pool.address, deepLiquidity]);
    await borrowed.write.mint([sellRouter.address, deepLiquidity]);
    await intermediate.write.mint([buyRouter.address, deepLiquidity]);
    await buyRouter.write.setRate([
      borrowed.address,
      intermediate.address,
      2n,
      1n,
    ]);
    await executor.write.setRouter([buyRouter.address, true]);
    await executor.write.setRouter([sellRouter.address, true]);
    await executor.write.setKeeper([keeper.account.address, true]);

    await viem.assertions.revertWithCustomError(
      executor.write.requestArbitrage(
        [
          borrowed.address,
          parseEther("1000"),
          {
            buyRouter: buyRouter.address,
            sellRouter: sellRouter.address,
            buyPath: [borrowed.address, intermediate.address],
            sellPath: [intermediate.address, borrowed.address],
            minBuyAmount: 0n,
            minFinalAmount: 0n,
            minProfit: 0n,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          },
        ],
        { account: stranger.account },
      ),
      executor,
      "NotKeeper",
    );

    // Existing funds must never subsidize a losing route.
    const protectedSeed = parseEther("100");
    await borrowed.write.mint([executor.address, protectedSeed]);

    const amount = parseEther("1000");
    const premium = (amount * 5n + 5_000n) / 10_000n;
    const minProfit = parseEther("1");
    let profitableExecutions = 0;
    let protectedSkips = 0;

    for (let index = 0; index < 10; index += 1) {
      const profitable = index !== 7;
      await sellRouter.write.setRate([
        intermediate.address,
        borrowed.address,
        profitable ? 51n : 49n,
        100n,
      ]);

      const firstQuote = (
        await buyRouter.read.getAmountsOut([
          amount,
          [borrowed.address, intermediate.address],
        ])
      ).at(-1);
      assert(firstQuote !== undefined);
      const finalQuote = (
        await sellRouter.read.getAmountsOut([
          firstQuote,
          [intermediate.address, borrowed.address],
        ])
      ).at(-1);
      assert(finalQuote !== undefined);

      const route = {
        buyRouter: buyRouter.address,
        sellRouter: sellRouter.address,
        buyPath: [borrowed.address, intermediate.address],
        sellPath: [intermediate.address, borrowed.address],
        minBuyAmount: (firstQuote * 9_970n) / 10_000n,
        minFinalAmount: amount + premium + minProfit,
        minProfit,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      };

      if (finalQuote >= route.minFinalAmount) {
        const balanceBefore = await borrowed.read.balanceOf([executor.address]);
        await executor.write.requestArbitrage(
          [borrowed.address, amount, route],
          { account: keeper.account },
        );
        const balanceAfter = await borrowed.read.balanceOf([executor.address]);
        assert(balanceAfter > balanceBefore, `trade ${index + 1} must make profit`);
        profitableExecutions += 1;
      } else {
        const balanceBefore = await borrowed.read.balanceOf([executor.address]);
        await viem.assertions.revertWithCustomError(
          executor.write.requestArbitrage(
            [
              borrowed.address,
              amount,
              { ...route, minFinalAmount: 0n },
            ],
            { account: keeper.account },
          ),
          executor,
          "InsufficientProfit",
        );
        assert.equal(
          await borrowed.read.balanceOf([executor.address]),
          balanceBefore,
          "failed route must be atomic",
        );
        protectedSkips += 1;
      }
    }

    assert.equal(profitableExecutions, 9);
    assert.equal(protectedSkips, 1);
    assert.equal((profitableExecutions / 10) * 100, 90);
    assert((await borrowed.read.balanceOf([executor.address])) > protectedSeed);
    assert.notEqual(await executor.read.pool(), zeroAddress);

    process.stdout.write(
      `\nSIMULATION RESULT: ${profitableExecutions}/10 profitable executions (90%); ${protectedSkips}/10 adverse trade protected; 0 live transactions sent.\n`,
    );
  });
});

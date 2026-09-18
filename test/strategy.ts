import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessOpportunity } from "../src/bot/strategy.js";

describe("opportunity assessment", () => {
  const profitable = {
    amount: 1_000_000n,
    firstOut: 2_000_000n,
    finalOut: 1_030_000n,
    flashFeeBps: 5n,
    gasUnits: 10_000n,
    feePerGas: 1n,
    gasBufferBps: 15_000n,
    fixedGasOverhead: 0n,
    maxGasCost: 200_000n,
    minNetProfit: 10_000n,
    slippageBps: 30n,
  };

  it("accepts a spread only after buffered gas and net profit", () => {
    const result = assessOpportunity(profitable);
    assert.equal(result.executable, true);
    assert.equal(result.premium, 500n);
    assert.equal(result.estimatedGasCost, 15_000n);
    assert.equal(result.expectedGrossProfit, 29_500n);
  });

  it("rejects spreads that do not clear the all-in floor", () => {
    const result = assessOpportunity({
      ...profitable,
      gasUnits: 15_000n,
      finalOut: 1_020_000n,
    });
    assert.equal(result.executable, false);
    assert.match(result.reason || "", /gas and minimum net profit/);
  });

  it("rejects gas above the configured cap", () => {
    const result = assessOpportunity({
      ...profitable,
      gasUnits: 1_000_000n,
    });
    assert.equal(result.executable, false);
    assert.match(result.reason || "", /gas exceeds/);
  });

  it("rejects negative economic inputs before calculation", () => {
    assert.throws(
      () => assessOpportunity({ ...profitable, feePerGas: -1n }),
      /economic inputs cannot be negative/,
    );
  });
});

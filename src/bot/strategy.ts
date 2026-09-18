const BPS = 10_000n;

export interface OpportunityInputs {
  amount: bigint;
  firstOut: bigint;
  finalOut: bigint;
  flashFeeBps: bigint;
  gasUnits: bigint;
  feePerGas: bigint;
  gasBufferBps: bigint;
  fixedGasOverhead: bigint;
  maxGasCost: bigint;
  minNetProfit: bigint;
  slippageBps: bigint;
}

export interface OpportunityAssessment {
  executable: boolean;
  reason?: string;
  premium: bigint;
  expectedGrossProfit: bigint;
  estimatedGasCost: bigint;
  expectedNetProfit: bigint;
  minBuyAmount: bigint;
  minFinalAmount: bigint;
  minProfit: bigint;
}

function mulDivUp(value: bigint, multiplier: bigint, denominator: bigint): bigint {
  if (value === 0n || multiplier === 0n) return 0n;
  return (value * multiplier + denominator - 1n) / denominator;
}

export function assessOpportunity(inputs: OpportunityInputs): OpportunityAssessment {
  if (
    inputs.amount < 0n ||
    inputs.firstOut < 0n ||
    inputs.finalOut < 0n ||
    inputs.flashFeeBps < 0n ||
    inputs.gasUnits < 0n ||
    inputs.feePerGas < 0n ||
    inputs.fixedGasOverhead < 0n ||
    inputs.maxGasCost < 0n ||
    inputs.minNetProfit < 0n
  ) {
    throw new Error("economic inputs cannot be negative");
  }
  if (inputs.slippageBps < 0n || inputs.slippageBps >= BPS) {
    throw new Error("slippageBps must be between 0 and 9999");
  }
  if (inputs.gasBufferBps < BPS) {
    throw new Error("gasBufferBps must be at least 10000");
  }

  // Aave rounds percentage math; rounding up here is deliberately conservative.
  const premium = mulDivUp(inputs.amount, inputs.flashFeeBps, BPS);
  const repayment = inputs.amount + premium;
  const expectedGrossProfit =
    inputs.finalOut > repayment ? inputs.finalOut - repayment : 0n;
  const bufferedVariableGas = mulDivUp(
    inputs.gasUnits * inputs.feePerGas,
    inputs.gasBufferBps,
    BPS,
  );
  const estimatedGasCost = bufferedVariableGas + inputs.fixedGasOverhead;
  const expectedNetProfit =
    expectedGrossProfit > estimatedGasCost
      ? expectedGrossProfit - estimatedGasCost
      : 0n;
  const minProfit = estimatedGasCost + inputs.minNetProfit;
  const slippageMultiplier = BPS - inputs.slippageBps;
  const minBuyAmount = (inputs.firstOut * slippageMultiplier) / BPS;
  const slippageProtectedFinal =
    (inputs.finalOut * slippageMultiplier) / BPS;
  const breakEvenFinal = repayment + minProfit;
  const minFinalAmount =
    slippageProtectedFinal > breakEvenFinal
      ? slippageProtectedFinal
      : breakEvenFinal;

  let reason: string | undefined;
  if (estimatedGasCost > inputs.maxGasCost) {
    reason = "estimated gas exceeds configured cap";
  } else if (expectedGrossProfit < minProfit) {
    reason = "spread does not cover gas and minimum net profit";
  } else if (minFinalAmount > inputs.finalOut) {
    reason = "slippage-adjusted output cannot meet the profit floor";
  }

  return {
    executable: reason === undefined,
    reason,
    premium,
    expectedGrossProfit,
    estimatedGasCost,
    expectedNetProfit,
    minBuyAmount,
    minFinalAmount,
    minProfit,
  };
}

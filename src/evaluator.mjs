export const ALLOCATION_RULES = Object.freeze({
  budgetMinorUnits: 10_000,
  maxTargetMinorUnits: 6_000,
  minLiquidityBps: 5_000,
  minScoreBps: 7_500,
});

function fail(code, message) {
  return { ok: false, code, message };
}

function isBasisPoints(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
}

function isPositiveMinorUnitAmount(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function evaluateAllocation(input) {
  if (!input || !Array.isArray(input.allocations) || input.allocations.length === 0) {
    return fail("EMPTY_RESULT", "at least one allocation is required");
  }
  if (!input.snapshot || typeof input.snapshot.id !== "string" || input.snapshot.id.length === 0
    || !Array.isArray(input.snapshot.targets) || input.snapshot.targets.length === 0) {
    return fail("INVALID_SNAPSHOT", "snapshot must have an id and at least one target");
  }

  const targets = new Map();
  for (const target of input.snapshot.targets) {
    if (!target || typeof target !== "object" || Array.isArray(target)
      || typeof target.id !== "string" || target.id.length === 0 || targets.has(target.id)) {
      return fail("INVALID_SNAPSHOT", "snapshot target ids must be non-empty and unique");
    }
    if (!isBasisPoints(target.liquidityBps) || !isBasisPoints(target.scoreBps)) {
      return fail("INVALID_TARGET_METRIC", "target metrics must be integer basis points from 0 to 10000");
    }
    targets.set(target.id, target);
  }

  const seen = new Set();
  let total = 0;
  let weightedScore = 0;

  for (const allocation of input.allocations) {
    if (!allocation || typeof allocation.target !== "string" || seen.has(allocation.target)) {
      return fail("DUPLICATE_OR_INVALID_TARGET", "targets must be unique and well formed");
    }
    seen.add(allocation.target);
    const target = targets.get(allocation.target);
    const amount = allocation.amountMinorUnits;
    if (!target) return fail("UNAUTHORIZED_TARGET", `target ${allocation.target} is not in the snapshot`);
    if (!isPositiveMinorUnitAmount(amount)) return fail("INVALID_AMOUNT", "amount must be a positive safe integer in minor units");
    if (amount > ALLOCATION_RULES.maxTargetMinorUnits) return fail("CONCENTRATION_LIMIT", "target concentration is too high");
    if (target.liquidityBps < ALLOCATION_RULES.minLiquidityBps) return fail("LIQUIDITY_FLOOR", "target liquidity is below the rule floor");
    total += amount;
    if (total > ALLOCATION_RULES.budgetMinorUnits) {
      return fail("BUDGET_MISMATCH", `expected ${ALLOCATION_RULES.budgetMinorUnits}, got ${total}`);
    }
    weightedScore += amount * target.scoreBps;
  }

  if (total !== ALLOCATION_RULES.budgetMinorUnits) return fail("BUDGET_MISMATCH", `expected ${ALLOCATION_RULES.budgetMinorUnits}, got ${total}`);
  const scoreBps = Math.floor(weightedScore / total);
  if (scoreBps < ALLOCATION_RULES.minScoreBps) return fail("SCORE_THRESHOLD", `expected at least ${ALLOCATION_RULES.minScoreBps}, got ${scoreBps}`);
  return { ok: true, totalMinorUnits: total, scoreBps, ruleVersion: "allocation-score-v1" };
}

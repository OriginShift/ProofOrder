export const ALLOCATION_RULES = Object.freeze({
  budgetMinorUnits: 10_000,
  maxTargetMinorUnits: 6_000,
  minLiquidityBps: 5_000,
  minScoreBps: 7_500,
});

function fail(code, message) {
  return { ok: false, code, message };
}

export function evaluateAllocation(input, rules = ALLOCATION_RULES) {
  if (!input || !Array.isArray(input.allocations) || input.allocations.length === 0) {
    return fail("EMPTY_RESULT", "at least one allocation is required");
  }
  const targets = new Map((input.snapshot?.targets ?? []).map((target) => [target.id, target]));
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
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail("INVALID_AMOUNT", "amount must be a positive integer");
    if (amount > rules.maxTargetMinorUnits) return fail("CONCENTRATION_LIMIT", "target concentration is too high");
    if (target.liquidityBps < rules.minLiquidityBps) return fail("LIQUIDITY_FLOOR", "target liquidity is below the rule floor");
    total += amount;
    weightedScore += amount * target.scoreBps;
  }

  if (total !== rules.budgetMinorUnits) return fail("BUDGET_MISMATCH", `expected ${rules.budgetMinorUnits}, got ${total}`);
  const scoreBps = Math.floor(weightedScore / total);
  if (scoreBps < rules.minScoreBps) return fail("SCORE_THRESHOLD", `expected at least ${rules.minScoreBps}, got ${scoreBps}`);
  return { ok: true, totalMinorUnits: total, scoreBps, ruleVersion: "allocation-score-v1" };
}

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAllocation } from "../src/evaluator.mjs";
import { canonicalOrder, orderDigest } from "../src/order.mjs";

const snapshot = {
  id: "fixed-snapshot-001",
  targets: [
    { id: "target-a", liquidityBps: 9000, scoreBps: 8200 },
    { id: "target-b", liquidityBps: 8000, scoreBps: 7600 },
    { id: "target-c", liquidityBps: 4000, scoreBps: 9500 },
  ],
};

const valid = {
  snapshot,
  allocations: [
    { target: "target-a", amountMinorUnits: 6000 },
    { target: "target-b", amountMinorUnits: 4000 },
  ],
};

test("accepts a fixed allocation that satisfies every rule", () => {
  const result = evaluateAllocation(valid);
  assert.equal(result.ok, true);
  assert.equal(result.totalMinorUnits, 10_000);
  assert.equal(result.scoreBps, 7960);
});

for (const [name, mutate, code] of [
  ["empty result", (value) => ({ ...value, allocations: [] }), "EMPTY_RESULT"],
  ["budget mismatch", (value) => ({ ...value, allocations: [{ target: "target-a", amountMinorUnits: 9000 }] }), "CONCENTRATION_LIMIT"],
  ["duplicate target", (value) => ({ ...value, allocations: [{ target: "target-a", amountMinorUnits: 5000 }, { target: "target-a", amountMinorUnits: 5000 }] }), "DUPLICATE_OR_INVALID_TARGET"],
  ["unauthorized target", (value) => ({ ...value, allocations: [{ target: "target-z", amountMinorUnits: 10_000 }] }), "UNAUTHORIZED_TARGET"],
  ["liquidity floor", (value) => ({ ...value, allocations: [{ target: "target-c", amountMinorUnits: 6000 }, { target: "target-a", amountMinorUnits: 4000 }] }), "LIQUIDITY_FLOOR"],
]) {
  test(`rejects ${name}`, () => assert.equal(evaluateAllocation(mutate(valid)).code, code));
}
test("rejects duplicate target ids in the snapshot", () => {
  const input = {
    ...valid,
    snapshot: {
      ...snapshot,
      targets: [...snapshot.targets, { ...snapshot.targets[0] }],
    },
  };

  assert.equal(evaluateAllocation(input).code, "INVALID_SNAPSHOT");
});

for (const [name, invalidMetrics] of [
  ["negative score", { scoreBps: -1 }],
  ["fractional score", { scoreBps: 7_500.5 }],
  ["string score", { scoreBps: "8200" }],
  ["score above 10000", { scoreBps: 10_001 }],
  ["negative liquidity", { liquidityBps: -1 }],
  ["fractional liquidity", { liquidityBps: 5_000.5 }],
  ["string liquidity", { liquidityBps: "9000" }],
  ["liquidity above 10000", { liquidityBps: 10_001 }],
]) {
  test(`rejects ${name}`, () => {
    const input = {
      ...valid,
      snapshot: {
        ...snapshot,
        targets: snapshot.targets.map((target) =>
          target.id === "target-a" ? { ...target, ...invalidMetrics } : target,
        ),
      },
    };

    assert.equal(evaluateAllocation(input).code, "INVALID_TARGET_METRIC");
  });
}

for (const [name, amountMinorUnits] of [
  ["negative amount", -1],
  ["fractional amount", 1.5],
  ["string amount", "6000"],
  ["unsafe integer amount", Number.MAX_SAFE_INTEGER + 1],
]) {
  test(`rejects ${name} without numeric coercion`, () => {
    const input = {
      ...valid,
      allocations: [{ target: "target-a", amountMinorUnits }],
    };

    assert.equal(evaluateAllocation(input).code, "INVALID_AMOUNT");
  });
}

test("accepts allocations exactly at the liquidity and score floors", () => {
  const input = {
    snapshot: {
      id: "threshold-snapshot",
      targets: [
        { id: "target-a", liquidityBps: 5_000, scoreBps: 7_500 },
        { id: "target-b", liquidityBps: 5_000, scoreBps: 7_500 },
      ],
    },
    allocations: [
      { target: "target-a", amountMinorUnits: 6_000 },
      { target: "target-b", amountMinorUnits: 4_000 },
    ],
  };

  assert.deepEqual(evaluateAllocation(input), {
    ok: true,
    totalMinorUnits: 10_000,
    scoreBps: 7_500,
    ruleVersion: "allocation-score-v1",
  });
});

test("rejects liquidity immediately below the fixed floor", () => {
  const input = {
    ...valid,
    snapshot: {
      ...snapshot,
      targets: snapshot.targets.map((target) =>
        target.id === "target-a" ? { ...target, liquidityBps: 4_999 } : target,
      ),
    },
  };

  assert.equal(evaluateAllocation(input).code, "LIQUIDITY_FLOOR");
});

test("rejects weighted score immediately below the fixed floor", () => {
  const input = {
    ...valid,
    snapshot: {
      ...snapshot,
      targets: snapshot.targets.map((target) =>
        target.id === "target-a" ? { ...target, scoreBps: 7_499 } : { ...target, scoreBps: 7_500 },
      ),
    },
  };

  assert.equal(evaluateAllocation(input).code, "SCORE_THRESHOLD");
});

test("rejects a multi-target total above the fixed budget", () => {
  const input = {
    ...valid,
    allocations: [
      { target: "target-a", amountMinorUnits: 6_000 },
      { target: "target-b", amountMinorUnits: 6_000 },
    ],
  };

  assert.equal(evaluateAllocation(input).code, "BUDGET_MISMATCH");
});

test("does not allow overriding the fixed task budget", () => {
  const input = {
    ...valid,
    allocations: [
      { target: "target-a", amountMinorUnits: 6_000 },
      { target: "target-b", amountMinorUnits: 3_000 },
    ],
  };

  const attemptedOverride = {
    budgetMinorUnits: 9_000,
    maxTargetMinorUnits: 6_000,
    minLiquidityBps: 5_000,
    minScoreBps: 7_500,
  };

  assert.equal(
    evaluateAllocation(input, attemptedOverride).code,
    "BUDGET_MISMATCH",
  );
});
test("canonical order digest is independent of object insertion order", async () => {
  const first = await orderDigest({ nonce: 7, buyer: "0xbuyer", provider: "0xprovider", payee: "0xprovider" });
  const second = await orderDigest({ payee: "0xprovider", provider: "0xprovider", buyer: "0xbuyer", nonce: 7 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, await orderDigest({ nonce: 8, buyer: "0xbuyer", provider: "0xprovider", payee: "0xprovider" }));
  assert.match(canonicalOrder({ nonce: 7 }), /"nonce":7/);
});

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

test("canonical order digest is independent of object insertion order", async () => {
  const first = await orderDigest({ nonce: 7, buyer: "0xbuyer", provider: "0xprovider", payee: "0xprovider" });
  const second = await orderDigest({ payee: "0xprovider", provider: "0xprovider", buyer: "0xbuyer", nonce: 7 });
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, await orderDigest({ nonce: 8, buyer: "0xbuyer", provider: "0xprovider", payee: "0xprovider" }));
  assert.match(canonicalOrder({ nonce: 7 }), /"nonce":7/);
});

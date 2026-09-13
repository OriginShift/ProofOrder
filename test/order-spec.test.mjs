import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ALLOCATION_RULES } from "../src/evaluator.mjs";
import { canonicalOrder, isValidOrderSpec, snapshotCommitment } from "../src/order.mjs";
import {
  FROZEN_ORDER_FIELDS,
  FROZEN_ORDER_SPEC,
  FROZEN_ORDER_SPEC_DIGEST,
  describeFrozenOrderSpec,
  freezeOrderSpec,
  verifyFrozenOrderSpec,
} from "../src/order-spec.mjs";

const snapshot = {
  id: "fixed-snapshot-001",
  targets: [
    { id: "target-a", liquidityBps: 9000, scoreBps: 8200 },
    { id: "target-b", liquidityBps: 8000, scoreBps: 7600 },
  ],
};

function draft(overrides = {}) {
  return {
    nonce: `0x${"ab".repeat(32)}`,
    chainId: 31337,
    settlementContract: "0x0000000000000000000000000000000000000001",
    buyer: "0x0000000000000000000000000000000000000002",
    provider: "0x0000000000000000000000000000000000000003",
    payee: "0x0000000000000000000000000000000000000003",
    deadline: 100_000,
    snapshot,
    recipientPublicKey: "recipient-public-key",
    verifierAddress: "0x0000000000000000000000000000000000000004",
    ...overrides,
  };
}

test("freezeOrderSpec fills the frozen constants and derives the input commitment", () => {
  const frozen = freezeOrderSpec(draft());

  assert.equal(frozen.ok, true);
  assert.equal(isValidOrderSpec(frozen.order), true);
  assert.deepEqual(
    Object.keys(frozen.order).sort(),
    [...FROZEN_ORDER_FIELDS].sort(),
  );
  assert.equal(frozen.order.version, 1);
  assert.equal(frozen.order.taskType, "constrained-allocation-v1");
  assert.equal(frozen.order.ruleId, "allocation-score-v1");
  assert.equal(frozen.order.verifierVersion, "ecdsa-evaluator-v1");
  assert.equal(frozen.order.paymentAsset, "native");
  assert.equal(frozen.order.feeMinorUnits, "100");
  assert.equal(frozen.order.deadlineSeconds, 900);
  assert.equal(frozen.order.inputCommitment, snapshotCommitment(snapshot));
  assert.deepEqual(frozen.order, JSON.parse(canonicalOrder(frozen.order)));
});

test("freezeOrderSpec is deterministic for the same draft", () => {
  const first = freezeOrderSpec(draft());
  const second = freezeOrderSpec(draft());

  assert.deepEqual(first, second);
});

test("freezeOrderSpec reports missing fields with a retryable code", () => {
  const missing = draft();
  delete missing.nonce;

  const frozen = freezeOrderSpec(missing);

  assert.equal(frozen.ok, false);
  assert.equal(frozen.code, "MISSING_FIELD");
  assert.equal(frozen.field, "nonce");
  assert.equal(frozen.retryable, true);
  assert.equal(Object.hasOwn(frozen, "order"), false);
});

test("freezeOrderSpec rejects unknown fields instead of silently dropping them", () => {
  const frozen = freezeOrderSpec(draft({ discountBps: 500 }));

  assert.equal(frozen.ok, false);
  assert.equal(frozen.code, "UNKNOWN_FIELD");
  assert.equal(frozen.field, "discountBps");
  assert.equal(frozen.retryable, true);
});

test("freezeOrderSpec refuses to change a frozen constant", () => {
  const frozen = freezeOrderSpec(draft({ ruleId: "other-rule" }));

  assert.equal(frozen.ok, false);
  assert.equal(frozen.code, "FROZEN_CONSTANT");
  assert.equal(frozen.field, "ruleId");
  assert.equal(frozen.retryable, false);
});

test("freezeOrderSpec refuses a fee outside the frozen integer range", () => {
  for (const feeMinorUnits of ["0", "-1", "1.5", 100, "1".repeat(79)]) {
    const frozen = freezeOrderSpec(draft({ feeMinorUnits }));
    assert.equal(frozen.ok, false, `accepted fee ${String(feeMinorUnits)}`);
    assert.equal(frozen.code, "INVALID_FIELD");
    assert.equal(frozen.field, "feeMinorUnits");
  }
  assert.equal(freezeOrderSpec(draft({ feeMinorUnits: "1" })).ok, true);
});

test("freezeOrderSpec requires the deadline to cover the declared window", () => {
  const frozen = freezeOrderSpec(draft({ deadline: 899, deadlineSeconds: 900 }));

  assert.equal(frozen.ok, false);
  assert.equal(frozen.code, "INVALID_FIELD");
  assert.equal(frozen.field, "deadline");
});

test("freezeOrderSpec rejects a snapshot shape outside the frozen schema", () => {
  const broken = { ...snapshot, targets: [{ id: "target-a", liquidityBps: 9000, scoreBps: 10_001 }] };
  const frozen = freezeOrderSpec(draft({ snapshot: broken }));

  assert.equal(frozen.ok, false);
  assert.equal(frozen.code, "INVALID_FIELD");
  assert.equal(frozen.field, "snapshot");
});

test("freezeOrderSpec rejects an input commitment that does not match its snapshot", () => {
  const frozen = freezeOrderSpec(draft({ inputCommitment: `sha256:${"0".repeat(64)}` }));

  assert.equal(frozen.ok, false);
  assert.equal(frozen.code, "SNAPSHOT_MISMATCH");
  assert.equal(frozen.field, "inputCommitment");
  assert.equal(frozen.retryable, true);
});

test("freezeOrderSpec accepts its own derived commitment unchanged", () => {
  const frozen = freezeOrderSpec(draft({ inputCommitment: snapshotCommitment(snapshot) }));

  assert.equal(frozen.ok, true);
  assert.equal(frozen.order.inputCommitment, snapshotCommitment(snapshot));
});

test("freezeOrderSpec rejects values that are not plain objects", () => {
  class OrderDraft {
    constructor() {
      Object.assign(this, draft());
    }
  }

  for (const value of [null, undefined, [], "order", new OrderDraft()]) {
    const frozen = freezeOrderSpec(value);
    assert.equal(frozen.ok, false, `accepted ${String(value)}`);
    assert.equal(frozen.code, "NOT_AN_OBJECT");
    assert.equal(frozen.retryable, true);
  }
});

test("verifyFrozenOrderSpec accepts a complete frozen order", () => {
  const order = freezeOrderSpec(draft()).order;
  const verified = verifyFrozenOrderSpec(order);

  assert.equal(verified.ok, true);
  assert.deepEqual(verified.order, order);
});

test("verifyFrozenOrderSpec does not fill defaults and reports each mutation", () => {
  const order = freezeOrderSpec(draft()).order;
  const mutations = [
    [{ version: 2 }, "FROZEN_CONSTANT", "version"],
    [{ paymentAsset: "TEST" }, "FROZEN_CONSTANT", "paymentAsset"],
    [{ verifierVersion: "g0-binding-experiment-v1" }, "FROZEN_CONSTANT", "verifierVersion"],
  ];

  for (const [patch, code, field] of mutations) {
    const result = verifyFrozenOrderSpec({ ...order, ...patch });
    assert.equal(result.ok, false, `accepted ${JSON.stringify(patch)}`);
    assert.equal(result.code, code);
    assert.equal(result.field, field);
    assert.equal(result.retryable, false);
  }

  const incomplete = { ...order };
  delete incomplete.deadlineSeconds;
  assert.equal(verifyFrozenOrderSpec(incomplete).code, "MISSING_FIELD");
});

test("verifyFrozenOrderSpec is stable when the canonical order carries a derived orderId", () => {
  const order = freezeOrderSpec(draft()).order;
  const withId = { ...order, orderId: `0x${"cd".repeat(32)}` };

  const verified = verifyFrozenOrderSpec(withId);

  assert.equal(verified.ok, true);
  assert.equal(verified.order.orderId, `0x${"cd".repeat(32)}`);
  assert.equal(verifyFrozenOrderSpec({ ...withId, orderId: "0x12" }).code, "INVALID_FIELD");
});

test("the frozen spec description is deep frozen and digestible", () => {
  assert.equal(Object.isFrozen(FROZEN_ORDER_SPEC), true);
  assert.equal(Object.isFrozen(FROZEN_ORDER_SPEC.allocationRules), true);
  assert.equal(Object.isFrozen(FROZEN_ORDER_SPEC.constants), true);
  assert.equal(Object.isFrozen(FROZEN_ORDER_SPEC.fields), true);
  assert.throws(() => {
    FROZEN_ORDER_SPEC.allocationRules.budgetMinorUnits = 1;
  }, TypeError);

  const description = describeFrozenOrderSpec();
  assert.equal(Object.isFrozen(description), false);
  assert.deepEqual(description.allocationRules, { ...ALLOCATION_RULES });
  assert.deepEqual(description.fields, [...FROZEN_ORDER_FIELDS]);
  const recomputed = `sha256:${createHash("sha256").update(JSON.stringify(description)).digest("hex")}`;
  assert.equal(FROZEN_ORDER_SPEC_DIGEST, recomputed);
  assert.match(FROZEN_ORDER_SPEC_DIGEST, /^sha256:[0-9a-f]{64}$/);
});

test("describeFrozenOrderSpec returns a fresh copy that cannot mutate the frozen rules", () => {
  const description = describeFrozenOrderSpec();
  description.allocationRules.budgetMinorUnits = 1;
  description.fields.push("extra");

  assert.deepEqual(FROZEN_ORDER_SPEC.allocationRules, { ...ALLOCATION_RULES });
  assert.deepEqual(describeFrozenOrderSpec().allocationRules, { ...ALLOCATION_RULES });
  assert.deepEqual(describeFrozenOrderSpec().fields, [...FROZEN_ORDER_FIELDS]);
});

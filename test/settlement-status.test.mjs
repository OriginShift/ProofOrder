import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTLEMENT_FAILURES,
  assertStatusSeparation,
  buildSettlementStatus,
  nextSettlementAction,
  retryableFailure,
} from "../src/settlement-status.mjs";

const ORDER_ID = `0x${"11".repeat(32)}`;
const ORDER_DIGEST = `0x${"22".repeat(32)}`;
const CIPHERTEXT = `0x${"33".repeat(32)}`;
const EVIDENCE = `0x${"44".repeat(32)}`;
const ZERO = `0x${"0".repeat(64)}`;

function record(overrides = {}) {
  return {
    buyer: "0x0000000000000000000000000000000000000002",
    provider: "0x0000000000000000000000000000000000000003",
    payee: "0x0000000000000000000000000000000000000003",
    amount: "1000000000000000000",
    deadline: 1_000_000,
    state: 1,
    orderDigest: ORDER_DIGEST,
    ciphertextCommitment: ZERO,
    evidenceDigest: ZERO,
    ...overrides,
  };
}

function status(overrides = {}, context = {}) {
  return buildSettlementStatus({
    orderId: ORDER_ID,
    chainId: 31337,
    contractAddress: "0x0000000000000000000000000000000000000001",
    verifierAddress: "0x0000000000000000000000000000000000000004",
    verificationGrace: 3_600,
    now: 1_000,
    record: record(),
    ...context,
    ...overrides,
  });
}

test("reports funding, verification and delivery independently", () => {
  const funded = status();
  assert.equal(funded.ok, true);
  assert.deepEqual(funded.funding.funded, true);
  assert.equal(funded.funding.amountWei, "1000000000000000000");
  assert.equal(funded.funding.buyer, record().buyer);
  assert.equal(funded.funding.payee, record().payee);
  assert.equal(funded.funding.deadline, 1_000_000);
  assert.equal(funded.verification.submitted, false);
  assert.equal(funded.verification.verified, false);
  assert.equal(funded.delivery.observed, false);
  assert.equal(funded.delivery.source, "chain-observes-no-delivery");
  assert.equal(funded.stateName, "Funded");
  assert.deepEqual(funded.errors, []);

  const verified = status({ record: record({ state: 3, ciphertextCommitment: CIPHERTEXT, evidenceDigest: EVIDENCE }) });
  assert.equal(verified.verification.submitted, true);
  assert.equal(verified.verification.verified, true);
  assert.equal(verified.verification.evidenceDigest, EVIDENCE);
  assert.equal(verified.delivery.observed, false, "verification must not be reported as delivery");
  assert.equal(verified.funding.funded, true, "verification must not clear funding");
});

test("assertStatusSeparation rejects a status that infers delivery from verification", () => {
  const honest = status({ record: record({ state: 3, ciphertextCommitment: CIPHERTEXT, evidenceDigest: EVIDENCE }) });
  assert.equal(assertStatusSeparation(honest), true);

  const dishonest = structuredClone(honest);
  dishonest.delivery.observed = true;
  assert.throws(() => assertStatusSeparation(dishonest), /DELIVERY_INFERRED_FROM_CHAIN/);

  const conflated = structuredClone(honest);
  conflated.delivery.source = "verification";
  assert.throws(() => assertStatusSeparation(conflated), /DELIVERY_INFERRED_FROM_CHAIN/);
});

test("a verified order still reports that delivery was not observed", () => {
  const verified = status({ record: record({ state: 3, ciphertextCommitment: CIPHERTEXT, evidenceDigest: EVIDENCE }) });
  assert.deepEqual(verified.delivery, {
    observed: false,
    source: "chain-observes-no-delivery",
    reason: "The settlement contract records a ciphertext commitment and a verifier attestation; it cannot observe that the buyer decrypted a valid result.",
  });
});

test("maps every state to one deterministic next action", () => {
  const cases = [
    [{ record: record({ state: 0, orderDigest: ZERO, amount: "0" }), now: 1_000 }, "fund", "buyer"],
    [{ record: record({ state: 1 }), now: 1_000 }, "await-submission", "provider"],
    [{ record: record({ state: 1 }), now: 1_000_001 }, "refund", "buyer-or-provider"],
    [{ record: record({ state: 2, ciphertextCommitment: CIPHERTEXT }), now: 1_000 }, "await-verification", "verifier"],
    [{ record: record({ state: 2, ciphertextCommitment: CIPHERTEXT }), now: 1_003_600 }, "refund", "anyone"],
    [{ record: record({ state: 3, ciphertextCommitment: CIPHERTEXT, evidenceDigest: EVIDENCE }), now: 1_000_000_000 }, "settle", "anyone"],
    [{ record: record({ state: 4, ciphertextCommitment: CIPHERTEXT, evidenceDigest: EVIDENCE }), now: 2_000_000 }, "complete", "none"],
    [{ record: record({ state: 5 }), now: 2_000_000 }, "complete", "none"],
  ];

  for (const [overrides, action, actor] of cases) {
    const decision = nextSettlementAction(status(overrides));
    assert.equal(decision.action, action, JSON.stringify(overrides.record));
    assert.equal(decision.actor, actor);
    assert.equal(typeof decision.reason, "string");
  }
});

test("treats the refund boundaries as inclusive for the caller that reached them", () => {
  const deadline = 1_000_000;
  const grace = 3_600;
  const atDeadline = nextSettlementAction(status({ record: record({ state: 1, deadline }), now: deadline }));
  assert.equal(atDeadline.action, "refund");

  const beforeDeadline = nextSettlementAction(status({ record: record({ state: 1, deadline }), now: deadline - 1 }));
  assert.equal(beforeDeadline.action, "await-submission");

  const atGrace = nextSettlementAction(status({ record: record({ state: 2, deadline, ciphertextCommitment: CIPHERTEXT }), now: deadline + grace }));
  assert.equal(atGrace.action, "refund");

  const beforeGrace = nextSettlementAction(status({ record: record({ state: 2, deadline, ciphertextCommitment: CIPHERTEXT }), now: deadline + grace - 1 }));
  assert.equal(beforeGrace.action, "await-verification");
});

test("rejects a status read from the wrong chain or contract", () => {
  const wrongChain = status({}, { expectedChainId: 1 });
  assert.equal(wrongChain.ok, false);
  assert.equal(wrongChain.code, "CHAIN_MISMATCH");
  assert.equal(wrongChain.retryable, false);

  const wrongContract = status({}, { expectedContractAddress: "0x0000000000000000000000000000000000000009" });
  assert.equal(wrongContract.ok, false);
  assert.equal(wrongContract.code, "CONTRACT_MISMATCH");
  assert.equal(wrongContract.retryable, false);

  const wrongVerifier = status({}, { expectedVerifierAddress: "0x0000000000000000000000000000000000000009" });
  assert.equal(wrongVerifier.ok, false);
  assert.equal(wrongVerifier.code, "VERIFIER_MISMATCH");
});

test("reports an unknown order as retryable and a digest mismatch as final", () => {
  const missing = status({ record: record({ state: 0, orderDigest: ZERO, amount: "0", buyer: "0x0000000000000000000000000000000000000000" }) });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "ORDER_NOT_FOUND");
  assert.equal(missing.retryable, true);

  const mismatched = status({}, { expectedOrderDigest: `0x${"55".repeat(32)}` });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, "ORDER_DIGEST_MISMATCH");
  assert.equal(mismatched.retryable, false);
});

test("exposes a stable failure catalogue", () => {
  assert.equal(Object.isFrozen(SETTLEMENT_FAILURES), true);
  assert.equal(retryableFailure("ORDER_NOT_FOUND"), true);
  assert.equal(retryableFailure("RPC_UNAVAILABLE"), true);
  assert.equal(retryableFailure("CHAIN_MISMATCH"), false);
  assert.equal(retryableFailure("ORDER_DIGEST_MISMATCH"), false);
  assert.equal(retryableFailure("NEVER_SEEN_BEFORE"), false);
  for (const [code, entry] of Object.entries(SETTLEMENT_FAILURES)) {
    assert.equal(typeof entry.retryable, "boolean", code);
    assert.equal(typeof entry.message, "string", code);
  }
});

test("keeps the settlement decision independent from the funding flag", () => {
  const settled = status({ record: record({ state: 4, ciphertextCommitment: CIPHERTEXT, evidenceDigest: EVIDENCE }), now: 2_000_000 });
  assert.equal(settled.funding.funded, true);
  assert.equal(nextSettlementAction(settled).action, "complete");

  const refunded = status({ record: record({ state: 5 }), now: 2_000_000 });
  assert.equal(refunded.funding.funded, false);
  assert.equal(refunded.verification.submitted, false);
  assert.equal(nextSettlementAction(refunded).action, "complete");
});

test("blocks an action when the status carries a non-retryable error", () => {
  const mismatched = status({}, { expectedOrderDigest: `0x${"55".repeat(32)}` });
  const decision = nextSettlementAction(mismatched);
  assert.equal(decision.action, "stop");
  assert.equal(decision.retryable, false);
  assert.equal(decision.actor, "none");
});

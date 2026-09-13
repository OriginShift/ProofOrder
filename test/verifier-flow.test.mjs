import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { buildEvidence } from "../src/evidence.mjs";
import { evaluateAllocation } from "../src/evaluator.mjs";
import { fixedAllocations, fixedSnapshot } from "../src/fixtures.mjs";
import { hex, orderDigest, orderIdFromDigest } from "../src/order.mjs";
import { freezeOrderSpec } from "../src/order-spec.mjs";
import { prepareProviderSubmission } from "../src/provider-flow.mjs";
import { buildSettlementStatus } from "../src/settlement-status.mjs";
import { generateRecipientKeyPair, sealResult, sealedResultCommitment } from "../src/sealed-result.mjs";
import { verifySubmittedDelivery } from "../src/verifier-flow.mjs";

const ZERO_HASH = `0x${"0".repeat(64)}`;
// A second allocation set that passes the frozen rule but produces a different score, so a
// self-consistent-but-wrong claim can be built.
const SECOND_ALLOCATIONS = [
  { target: "target-a", amountMinorUnits: 5000 },
  { target: "target-b", amountMinorUnits: 5000 },
];
const FAILING_ALLOCATIONS = [
  { target: "target-a", amountMinorUnits: 6000 },
  { target: "target-b", amountMinorUnits: 3000 },
];

async function fixture() {
  const recipient = await generateRecipientKeyPair();
  const frozen = freezeOrderSpec({
    nonce: `0x${"ab".repeat(32)}`,
    chainId: 31337,
    settlementContract: "0x0000000000000000000000000000000000000001",
    buyer: "0x0000000000000000000000000000000000000002",
    provider: "0x0000000000000000000000000000000000000003",
    payee: "0x0000000000000000000000000000000000000003",
    deadline: 1_000_000,
    snapshot: fixedSnapshot(),
    recipientPublicKey: recipient.publicKey,
    verifierAddress: "0x0000000000000000000000000000000000000004",
  });
  assert.equal(frozen.ok, true);
  const order = frozen.order;
  const prepared = await prepareProviderSubmission({
    order,
    allocations: fixedAllocations(),
    recipientPublicKey: recipient.publicKey,
  });
  assert.equal(prepared.ok, true);
  const digest = `sha256:${hex(await orderDigest(order))}`;
  const orderId = orderIdFromDigest(digest);
  const submission = {
    schemaVersion: 1,
    orderId,
    orderDigest: digest,
    ciphertextCommitment: prepared.ciphertextCommitment,
    sealedResult: prepared.sealedResult,
    evidence: prepared.evidence,
    submittedAt: "2026-09-13T00:00:00.000Z",
  };
  return { recipient, order, orderId, digest, prepared, submission };
}

function chainStatusFor({ order, orderId, ciphertextCommitment = ZERO_HASH, state = 2, evidenceDigest = ZERO_HASH }) {
  return buildSettlementStatus({
    orderId,
    chainId: order.chainId,
    contractAddress: order.settlementContract,
    verifierAddress: order.verifierAddress,
    verificationGrace: 3_600,
    now: 1_000,
    record: {
      buyer: order.buyer,
      provider: order.provider,
      payee: order.payee,
      amount: order.feeMinorUnits,
      deadline: order.deadline,
      state,
      orderDigest: `0x${"11".repeat(32)}`,
      ciphertextCommitment,
      evidenceDigest,
    },
  });
}

test("accepts a delivery the verifier opened and re-evaluated itself", async () => {
  const f = await fixture();
  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: f.submission,
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: chainStatusFor({ order: f.order, orderId: f.orderId, ciphertextCommitment: f.submission.ciphertextCommitment }),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.code, "INDEPENDENTLY_VERIFIED");
  assert.equal(result.verificationPath, "independent-decrypt-and-reevaluate");
  assert.deepEqual(result.evaluation, f.prepared.evaluation);
  assert.equal(isDeepStrictEqual(result.evaluation, f.submission.evidence.evaluation), true);
  assert.equal(result.evidenceDigest, f.submission.evidence.evidenceDigest);
  assert.deepEqual(result.chain, {
    state: 2,
    stateName: "Submitted",
    ciphertextCommitment: f.submission.ciphertextCommitment,
    alreadyVerified: false,
  });
  assert.equal(result.disclosure.verifierDecryptionCapability, true);
  assert.equal(result.deliveryObserved, false);
});

test("rejects unbound plaintext: a valid result does not prove ciphertext contents", async () => {
  const f = await fixture();
  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: f.submission,
    plaintextResult: { allocations: fixedAllocations() },
    chainStatus: chainStatusFor({ order: f.order, orderId: f.orderId, ciphertextCommitment: f.submission.ciphertextCommitment }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "UNBOUND_PLAINTEXT_REFUSED");
});

test("rejects a self-consistent provider claim that the recovered result contradicts", async () => {
  const f = await fixture();
  const claimed = evaluateAllocation({ snapshot: f.order.snapshot, allocations: SECOND_ALLOCATIONS });
  assert.equal(claimed.ok, true);
  assert.notDeepEqual(claimed, f.prepared.evaluation);
  const submission = {
    ...f.submission,
    // Internally consistent with its own digest, but not the evaluation of the committed bytes.
    evidence: buildEvidence({
      orderDigest: f.digest,
      ciphertextCommitment: f.submission.ciphertextCommitment,
      evaluation: claimed,
    }),
  };

  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission,
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: chainStatusFor({ order: f.order, orderId: f.orderId, ciphertextCommitment: f.submission.ciphertextCommitment }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "EVALUATION_MISMATCH");
  assert.deepEqual(result.rederived, f.prepared.evaluation);
  assert.deepEqual(result.claimed, claimed);
});

test("rejects a replaced sealed result", async () => {
  const f = await fixture();
  const replacement = await prepareProviderSubmission({
    order: f.order,
    allocations: SECOND_ALLOCATIONS,
    recipientPublicKey: f.recipient.publicKey,
  });
  assert.equal(replacement.ok, true);
  const submission = { ...f.submission, sealedResult: replacement.sealedResult };

  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission,
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: chainStatusFor({ order: f.order, orderId: f.orderId, ciphertextCommitment: f.submission.ciphertextCommitment }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "CIPHERTEXT_COMMITMENT_MISMATCH");
});

test("refuses to attest without an independent input", async () => {
  const f = await fixture();
  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: f.submission,
    chainStatus: chainStatusFor({ order: f.order, orderId: f.orderId, ciphertextCommitment: f.submission.ciphertextCommitment }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "MISSING_VERIFICATION_INPUT");
  assert.equal(result.retryable, true);
});

test("rejects authenticated ciphertext containing allocations that fail the rule", async () => {
  const f = await fixture();
  f.submission.sealedResult = await sealResult({ plaintext: Buffer.from(JSON.stringify({ allocations: FAILING_ALLOCATIONS })), recipientPublicKey: f.recipient.publicKey, orderDigest: `0x${f.digest.slice(7)}` });
  f.submission.ciphertextCommitment = sealedResultCommitment(f.submission.sealedResult);
  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: f.submission,
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: chainStatusFor({ order: f.order, orderId: f.orderId, ciphertextCommitment: f.submission.ciphertextCommitment }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "RESULT_EVALUATION_FAILED");
  assert.equal(result.evaluation.code, "BUDGET_MISMATCH");
});

test("rejects a chain binding that records a different ciphertext", async () => {
  const f = await fixture();
  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: f.submission,
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: chainStatusFor({
      order: f.order,
      orderId: f.orderId,
      ciphertextCommitment: `0x${"22".repeat(32)}`,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "CHAIN_CIPHERTEXT_MISMATCH");
});

test("rejects an order that is funded but not yet submitted", async () => {
  const f = await fixture();
  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: f.submission,
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: chainStatusFor({ order: f.order, orderId: f.orderId, state: 1 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "NOT_SUBMITTED");
  assert.equal(result.retryable, true);
});

test("rejects chain terms that differ from the frozen order", async () => {
  const f = await fixture();
  const status = chainStatusFor({ order: f.order, orderId: f.orderId, ciphertextCommitment: f.submission.ciphertextCommitment });
  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: f.submission,
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: { ...status, funding: { ...status.funding, amountWei: "2" } },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "CHAIN_ORDER_MISMATCH");
});

test("rejects a submission bound to a different order", async () => {
  const f = await fixture();
  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: { ...f.submission, orderId: `0x${"33".repeat(32)}` },
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: chainStatusFor({ order: f.order, orderId: f.orderId, ciphertextCommitment: f.submission.ciphertextCommitment }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ORDER_ID_MISMATCH");
});

test("rejects a tampered order instead of attesting it", async () => {
  const f = await fixture();
  const result = await verifySubmittedDelivery({
    order: { ...f.order, ruleId: "other-rule" },
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: f.submission,
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: chainStatusFor({ order: f.order, orderId: f.orderId, ciphertextCommitment: f.submission.ciphertextCommitment }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_ORDER");
  assert.equal(result.retryable, false);
});

test("reports an already verified order without re-attesting blindly", async () => {
  const f = await fixture();
  const result = await verifySubmittedDelivery({
    order: f.order,
    orderId: f.orderId,
    orderDigest: f.digest,
    submission: f.submission,
    recipientPrivateKey: f.recipient.privateKey,
    chainStatus: chainStatusFor({
      order: f.order,
      orderId: f.orderId,
      state: 3,
      ciphertextCommitment: f.submission.ciphertextCommitment,
      evidenceDigest: `0x${f.submission.evidence.evidenceDigest.slice(7)}`,
    }),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.chain.alreadyVerified, true);
});

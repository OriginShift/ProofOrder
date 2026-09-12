import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidence } from "../src/evidence.mjs";
import { canonicalOrder, hex, orderDigest, snapshotCommitment } from "../src/order.mjs";
import { prepareProviderSubmission } from "../src/provider-flow.mjs";
import { generateRecipientKeyPair, openSealedResult, sealedResultCommitment } from "../src/sealed-result.mjs";

const snapshot = {
  id: "fixed-snapshot-001",
  targets: [
    { id: "target-a", liquidityBps: 9000, scoreBps: 8200 },
    { id: "target-b", liquidityBps: 8000, scoreBps: 7600 },
  ],
};
const allocations = [
  { target: "target-a", amountMinorUnits: 6000 },
  { target: "target-b", amountMinorUnits: 4000 },
];

function makeOrder(recipientPublicKey, overrides = {}) {
  return JSON.parse(canonicalOrder({
    version: 1,
    nonce: `0x${"ab".repeat(32)}`,
    chainId: 31337,
    settlementContract: "0x0000000000000000000000000000000000000001",
    buyer: "0x0000000000000000000000000000000000000002",
    provider: "0x0000000000000000000000000000000000000003",
    payee: "0x0000000000000000000000000000000000000003",
    taskType: "constrained-allocation-v1",
    ruleId: "allocation-score-v1",
    verifierVersion: "ecdsa-evaluator-v1",
    paymentAsset: "native",
    feeMinorUnits: "100",
    deadlineSeconds: 900,
    deadline: 2_000,
    snapshot,
    inputCommitment: snapshotCommitment(snapshot),
    recipientPublicKey,
    verifierAddress: "0x0000000000000000000000000000000000000004",
    ...overrides,
  }));
}

test("provider validates, seals and commits the accepted fixed allocation", async () => {
  const recipient = await generateRecipientKeyPair();
  const order = makeOrder(recipient.publicKey);
  const response = await prepareProviderSubmission({
    order,
    allocations,
    recipientPublicKey: recipient.publicKey,
  });
  const orderDigestHex = `0x${hex(await orderDigest(order))}`;

  assert.equal(response.ok, true);
  assert.equal(response.orderDigestHex, orderDigestHex);
  assert.deepEqual(response.evaluation, {
    ok: true,
    totalMinorUnits: 10_000,
    scoreBps: 7960,
    ruleVersion: "allocation-score-v1",
  });
  assert.equal(response.ciphertextCommitment, sealedResultCommitment(response.sealedResult));
  assert.deepEqual(response.evidence, buildEvidence({
    orderDigest: `sha256:${orderDigestHex.slice(2)}`,
    ciphertextCommitment: `sha256:${response.ciphertextCommitment.slice(2)}`,
    evaluation: response.evaluation,
  }));

  const plaintext = await openSealedResult({
    sealedResult: response.sealedResult,
    recipientPrivateKey: recipient.privateKey,
    expectedOrderDigest: orderDigestHex,
  });
  assert.deepEqual(JSON.parse(Buffer.from(plaintext).toString("utf8")), { allocations });
});

test("rejected provider allocations produce no ciphertext or evidence", async () => {
  const recipientPublicKey = "not-a-public-key";
  const response = await prepareProviderSubmission({
    order: makeOrder(recipientPublicKey),
    allocations: [{ target: "target-a", amountMinorUnits: 5_000 }],
    recipientPublicKey,
  });

  assert.deepEqual(response, {
    ok: false,
    error: { code: "BUDGET_MISMATCH", message: "expected 10000, got 5000" },
  });
  assert.equal(Object.hasOwn(response, "sealedResult"), false);
  assert.equal(Object.hasOwn(response, "evidence"), false);
});

test("rejects a snapshot that does not match the order commitment before encryption", async () => {
  const recipientPublicKey = "not-a-public-key";
  const response = await prepareProviderSubmission({
    order: makeOrder(recipientPublicKey, { inputCommitment: "sha256:stale-input-commitment" }),
    allocations,
    recipientPublicKey,
  });

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "INPUT_COMMITMENT_MISMATCH",
      message: "Order input commitment does not match its snapshot.",
    },
  });
  assert.equal(Object.hasOwn(response, "sealedResult"), false);
  assert.equal(Object.hasOwn(response, "evidence"), false);
});

test("rejects a recipient key that differs from the order before encryption", async () => {
  const recipient = await generateRecipientKeyPair();
  const response = await prepareProviderSubmission({
    order: makeOrder(recipient.publicKey),
    allocations,
    recipientPublicKey: "not-a-public-key",
  });

  assert.deepEqual(response, {
    ok: false,
    error: { code: "RECIPIENT_KEY_MISMATCH", message: "Recipient key does not match the order." },
  });
});

test("rejects an order that selects a different fixed rule", async () => {
  const recipient = await generateRecipientKeyPair();
  const response = await prepareProviderSubmission({
    order: makeOrder(recipient.publicKey, { ruleId: "other-rule" }),
    allocations,
    recipientPublicKey: recipient.publicKey,
  });

  assert.deepEqual(response, {
    ok: false,
    error: { code: "INVALID_ORDER", message: "Order does not match the fixed task and settlement schema." },
  });
});

test("rejects an order snapshot with fields the recovery schema will not accept", async () => {
  const recipient = await generateRecipientKeyPair();
  const extendedSnapshot = {
    ...snapshot,
    targets: snapshot.targets.map((target) => ({ ...target, source: "uncommitted-metadata" })),
  };
  const response = await prepareProviderSubmission({
    order: makeOrder(recipient.publicKey, {
      snapshot: extendedSnapshot,
      inputCommitment: snapshotCommitment(extendedSnapshot),
    }),
    allocations,
    recipientPublicKey: recipient.publicKey,
  });

  assert.deepEqual(response, {
    ok: false,
    error: { code: "INVALID_ORDER", message: "Order snapshot does not match the fixed allocation schema." },
  });
});

test("rejects an order without its recipient key", async () => {
  const recipient = await generateRecipientKeyPair();
  const order = makeOrder(recipient.publicKey);
  delete order.recipientPublicKey;

  const response = await prepareProviderSubmission({
    order,
    allocations,
    recipientPublicKey: recipient.publicKey,
  });

  assert.deepEqual(response, {
    ok: false,
    error: { code: "INVALID_ORDER", message: "Order does not match the fixed task and settlement schema." },
  });
});

test("evaluates and seals one snapshot of allocation values", async () => {
  const recipient = await generateRecipientKeyPair();
  let targetReads = 0;
  const changingAllocation = {
    get target() {
      targetReads += 1;
      return targetReads === 1 ? "target-a" : "target-c";
    },
    amountMinorUnits: 6_000,
  };
  const response = await prepareProviderSubmission({
    order: makeOrder(recipient.publicKey),
    allocations: [changingAllocation, allocations[1]],
    recipientPublicKey: recipient.publicKey,
  });

  assert.equal(response.ok, true);
  assert.equal(targetReads, 1);
  const plaintext = await openSealedResult({
    sealedResult: response.sealedResult,
    recipientPrivateKey: recipient.privateKey,
    expectedOrderDigest: response.orderDigestHex,
  });
  assert.deepEqual(JSON.parse(Buffer.from(plaintext).toString("utf8")), { allocations });
});
test("rejects unreadable allocation data before encryption", async () => {
  const recipient = await generateRecipientKeyPair();
  const unreadableAllocation = {
    get target() {
      throw new Error("unreadable target");
    },
    amountMinorUnits: 6000,
  };

  const response = await prepareProviderSubmission({
    order: makeOrder(recipient.publicKey),
    allocations: [unreadableAllocation, allocations[1]],
    recipientPublicKey: recipient.publicKey,
  });

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "INVALID_ALLOCATION_INPUT",
      message: "Allocation data must be readable.",
    },
  });
  assert.equal(Object.hasOwn(response, "sealedResult"), false);
  assert.equal(Object.hasOwn(response, "evidence"), false);
});
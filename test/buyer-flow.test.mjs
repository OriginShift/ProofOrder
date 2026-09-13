import assert from "node:assert/strict";
import test from "node:test";
import { getBytes, solidityPackedKeccak256, Wallet } from "ethers";
import { buildEvidence } from "../src/evidence.mjs";
import { createBuyerCheckpoint, requireSettlementAllowed, verifyBuyerCheckpoint, verifyProviderSubmission } from "../src/buyer-flow.mjs";
import { freezeOrderSpec } from "../src/order-spec.mjs";
import { orderDigest, orderIdFromDigest, snapshotCommitment } from "../src/order.mjs";
import { prepareProviderSubmission } from "../src/provider-flow.mjs";
import { createEncryptedRecoveryBundle, recoverEncryptedResult } from "../src/recovery.mjs";
import { generateRecipientKeyPair } from "../src/sealed-result.mjs";

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
const CONTRACT = "0x0000000000000000000000000000000000000001";
const VERIFIER = "0x0000000000000000000000000000000000000004";

async function fixture(overrides = {}) {
  const recipient = await generateRecipientKeyPair();
  const buyer = Wallet.createRandom();
  const provider = Wallet.createRandom();
  const verifier = overrides.verifier ?? Wallet.createRandom();
  const frozen = freezeOrderSpec({
    nonce: `0x${"ab".repeat(32)}`,
    chainId: 31337,
    settlementContract: CONTRACT,
    buyer: buyer.address,
    provider: provider.address,
    payee: provider.address,
    deadline: 100_000,
    snapshot,
    recipientPublicKey: recipient.publicKey,
    verifierAddress: verifier.address,
  });
  assert.equal(frozen.ok, true, frozen.code);
  const order = frozen.order;
  const digest = `sha256:${Buffer.from(await orderDigest(order)).toString("hex")}`;
  const orderId = orderIdFromDigest(digest);
  const submission = await prepareProviderSubmission({
    order,
    allocations: overrides.allocations ?? allocations,
    recipientPublicKey: recipient.publicKey,
  });
  assert.equal(submission.ok, true, submission.error?.code);
  const messageHash = solidityPackedKeccak256(
    ["string", "uint256", "address", "bytes32", "bytes32", "bytes32", "bytes32"],
    ["ProofOrder/VerificationEvidence/v1", 31337, CONTRACT, orderId, `0x${digest.slice(7)}`,
      submission.ciphertextCommitment, `0x${submission.evidence.evidenceDigest.slice(7)}`],
  );
  const signature = await verifier.signMessage(getBytes(messageHash));
  const bundle = await createEncryptedRecoveryBundle({
    orderId, order, sealedResult: submission.sealedResult, evidence: submission.evidence,
    signature, verifierAddress: verifier.address,
  });
  const checkpoint = await createBuyerCheckpoint({ order, orderId, createdAt: "2026-09-13T00:00:00.000Z" });
  return { order, orderId, digest, submission, bundle, checkpoint, recipient, verifier };
}

test("freezes a buyer checkpoint that binds the order, chain, contract and verifier", async () => {
  const { checkpoint, order, orderId, digest, verifier } = await fixture();

  assert.equal(checkpoint.ok, true);
  assert.equal(checkpoint.checkpoint.schemaVersion, 1);
  assert.equal(checkpoint.checkpoint.orderId, orderId);
  assert.equal(checkpoint.checkpoint.orderDigest, digest);
  assert.equal(checkpoint.checkpoint.chainId, 31337);
  assert.equal(checkpoint.checkpoint.contractAddress, CONTRACT);
  assert.equal(checkpoint.checkpoint.verifierAddress, verifier.address);
  assert.equal(checkpoint.checkpoint.checkpointedAt, "2026-09-13T00:00:00.000Z");
  assert.deepEqual(checkpoint.checkpoint.order, order);
  assert.deepEqual(Object.keys(checkpoint.checkpoint.trust).sort(),
    ["expectedChainId", "expectedContractAddress", "expectedOrderDigest", "expectedOrderId", "expectedVerifierAddress"]);
});

test("refuses to checkpoint an order outside the frozen specification", async () => {
  const broken = await createBuyerCheckpoint({
    order: { version: 1, nonce: "0x00" },
    orderId: `0x${"11".repeat(32)}`,
  });

  assert.equal(broken.ok, false);
  assert.equal(broken.code, "INVALID_ORDER");
  assert.equal(Object.hasOwn(broken, "checkpoint"), false);
});

test("refuses a checkpoint that carries key material", async () => {
  const { order, orderId } = await fixture();
  const withKey = await createBuyerCheckpoint({ order, orderId, recipientPrivateKey: "secret" });

  assert.equal(withKey.ok, false);
  assert.equal(withKey.code, "PRIVATE_KEY_REFUSED");
});

test("verifies its own checkpoint and rejects a mutated order", async () => {
  const { checkpoint } = await fixture();
  const verified = await verifyBuyerCheckpoint(checkpoint.checkpoint);
  assert.equal(verified.ok, true);
  assert.equal(verified.checkpoint.orderDigest, checkpoint.checkpoint.orderDigest);

  const mutated = structuredClone(checkpoint.checkpoint);
  mutated.order.payee = "0x00000000000000000000000000000000000000ff";
  const rejected = await verifyBuyerCheckpoint(mutated);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "ORDER_DIGEST_MISMATCH");
  assert.equal(rejected.retryable, false);
});

test("rejects a checkpoint that binds another chain, contract or verifier", async () => {
  const { checkpoint } = await fixture();
  for (const [patch, code] of [
    [{ chainId: 1 }, "CHAIN_MISMATCH"],
    [{ contractAddress: "0x0000000000000000000000000000000000000009" }, "CONTRACT_MISMATCH"],
    [{ verifierAddress: "0x0000000000000000000000000000000000000009" }, "VERIFIER_MISMATCH"],
  ]) {
    const verified = await verifyBuyerCheckpoint({ ...checkpoint.checkpoint, ...patch });
    assert.equal(verified.ok, false, JSON.stringify(patch));
    assert.equal(verified.code, code);
  }
});

test("rejects a malformed or extended checkpoint", async () => {
  const { checkpoint } = await fixture();
  for (const value of [null, [], "checkpoint", { schemaVersion: 2 }]) {
    const verified = await verifyBuyerCheckpoint(value);
    assert.equal(verified.ok, false, String(value));
    assert.equal(verified.code, "INVALID_CHECKPOINT");
  }
  const extended = await verifyBuyerCheckpoint({ ...checkpoint.checkpoint, note: "extra" });
  assert.equal(extended.code, "UNKNOWN_FIELD");
  assert.equal(extended.field, "note");
});

test("accepts the provider bundle that matches the checkpoint and reports the decision", async () => {
  const { checkpoint, bundle, digest, verifier } = await fixture();
  const verified = await verifyProviderSubmission({ checkpoint: checkpoint.checkpoint, bundle });

  assert.equal(verified.ok, true);
  assert.equal(verified.decision, "accept-and-checkpoint");
  assert.equal(verified.orderDigest, digest);
  assert.equal(verified.ciphertextCommitment, bundle.ciphertextCommitment);
  assert.equal(verified.verification.verifierAddress, verifier.address);
  assert.equal(verified.retryable, false);
});

test("rejects a bundle delivered for another order, recipient or verifier", async () => {
  const first = await fixture();
  const second = await fixture();

  // The bundle carries a different order, so the checkpoint comparison fails before any digest check.
  const otherOrder = await verifyProviderSubmission({ checkpoint: first.checkpoint.checkpoint, bundle: second.bundle });
  assert.equal(otherOrder.ok, false);
  assert.equal(otherOrder.code, "ORDER_MISMATCH");
  assert.equal(otherOrder.retryable, false);

  const foreignRecipient = structuredClone(first.bundle);
  foreignRecipient.sealedResult.recipientPublicKey = second.recipient.publicKey;
  const recipientMismatch = await verifyProviderSubmission({ checkpoint: first.checkpoint.checkpoint, bundle: foreignRecipient });
  assert.equal(recipientMismatch.ok, false);
  assert.equal(recipientMismatch.code, "RECIPIENT_MISMATCH");

  const foreignSignature = structuredClone(first.bundle);
  foreignSignature.attestation.signature = await second.verifier.signMessage(getBytes(`0x${"00".repeat(32)}`));
  const signatureMismatch = await verifyProviderSubmission({ checkpoint: first.checkpoint.checkpoint, bundle: foreignSignature });
  assert.equal(signatureMismatch.ok, false);
  assert.equal(signatureMismatch.code, "INVALID_SIGNATURE");
});

test("rejects a replaced ciphertext or a rewritten evaluation", async () => {
  const { checkpoint, bundle } = await fixture();

  const replaced = structuredClone(bundle);
  const bytes = Buffer.from(replaced.sealedResult.ciphertext, "base64");
  bytes[0] ^= 0xff;
  replaced.sealedResult.ciphertext = bytes.toString("base64");
  const ciphertext = await verifyProviderSubmission({ checkpoint: checkpoint.checkpoint, bundle: replaced });
  assert.equal(ciphertext.ok, false);
  assert.equal(ciphertext.code, "CIPHERTEXT_COMMITMENT_MISMATCH");

  const rewritten = structuredClone(bundle);
  rewritten.evidence.evaluation.scoreBps = 10_000;
  const evidence = await verifyProviderSubmission({ checkpoint: checkpoint.checkpoint, bundle: rewritten });
  assert.equal(evidence.ok, false);
  assert.equal(evidence.code, "EVIDENCE_MISMATCH");
});

test("names the caller error when the checkpoint trust anchor is missing", async () => {
  const { bundle } = await fixture();
  const verified = await verifyProviderSubmission({ checkpoint: undefined, bundle });

  assert.equal(verified.ok, false);
  assert.equal(verified.code, "INVALID_TRUST");
  assert.equal(verified.retryable, true);
  assert.equal(verified.decision, "supply-checkpoint");
});

test("allows settlement only after a verified checkpoint and a verified chain state", async () => {
  const { checkpoint, bundle } = await fixture();
  const verification = await verifyProviderSubmission({ checkpoint: checkpoint.checkpoint, bundle });
  const chainVerified = {
    ok: true, state: 3, stateName: "Verified", terminal: false,
    funding: { funded: true, deadlineReached: false },
    verification: { submitted: true, verified: true, verificationDeadline: 103_600, windowOpen: true },
    delivery: { observed: false, source: "chain-observes-no-delivery", reason: "" },
  };

  const noCheckpoint = requireSettlementAllowed({ checkpoint: undefined, verification, chainStatus: chainVerified });
  assert.equal(noCheckpoint.ok, false);
  assert.equal(noCheckpoint.code, "MISSING_CHECKPOINT");
  assert.equal(noCheckpoint.retryable, true);

  const unverified = requireSettlementAllowed({
    checkpoint: checkpoint.checkpoint,
    verification: { ok: false, code: "ORDER_ID_MISMATCH", retryable: false },
    chainStatus: chainVerified,
  });
  assert.equal(unverified.ok, false);
  assert.equal(unverified.code, "SUBMISSION_NOT_VERIFIED");
  assert.equal(unverified.cause, "ORDER_ID_MISMATCH");

  const allowed = requireSettlementAllowed({ checkpoint: checkpoint.checkpoint, verification, chainStatus: chainVerified });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.action, "settle");
  assert.equal(allowed.actor, "anyone");

  const notReady = requireSettlementAllowed({
    checkpoint: checkpoint.checkpoint, verification,
    chainStatus: { ...chainVerified, state: 2, stateName: "Submitted", verification: { ...chainVerified.verification, verified: false } },
  });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.code, "CHAIN_NOT_READY");
  assert.equal(notReady.nextAction, "await-verification");

  const dead = requireSettlementAllowed({
    checkpoint: checkpoint.checkpoint, verification,
    chainStatus: {
      ...chainVerified, state: 2, stateName: "Submitted",
      verification: { ...chainVerified.verification, verified: false, windowOpen: false },
    },
  });
  assert.equal(dead.ok, true);
  assert.equal(dead.action, "refund");

  const broken = requireSettlementAllowed({
    checkpoint: checkpoint.checkpoint, verification,
    chainStatus: { ok: false, code: "CHAIN_MISMATCH", message: "wrong chain", retryable: false },
  });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, "CHAIN_MISMATCH");
  assert.equal(broken.retryable, false);
});

test("binds every checkpoint to a distinct order id", async () => {
  const first = await fixture();
  const second = await fixture();

  assert.notEqual(first.orderId, second.orderId);
  assert.equal(first.orderId, orderIdFromDigest(first.digest));
  const crossed = await verifyBuyerCheckpoint({ ...first.checkpoint.checkpoint, orderId: second.orderId });
  assert.equal(crossed.ok, false);
  assert.equal(crossed.code, "ORDER_ID_MISMATCH");
});

test("the recovered plaintext carries the checkpointed order's allocations", async () => {
  const { checkpoint, bundle, recipient } = await fixture();
  const recovered = await recoverEncryptedResult(bundle, {
    ...checkpoint.checkpoint.trust,
    recipientPrivateKey: recipient.privateKey,
  });

  assert.equal(recovered.ok, true, recovered.code);
  assert.deepEqual(recovered.result, { allocations });
});

test("the evaluation in the accepted evidence is reproducible from the checkpointed snapshot", async () => {
  const { checkpoint, bundle } = await fixture();
  const expected = buildEvidence({
    orderDigest: checkpoint.checkpoint.orderDigest,
    ciphertextCommitment: bundle.ciphertextCommitment,
    evaluation: bundle.evidence.evaluation,
  });
  assert.deepEqual(expected, bundle.evidence);
  assert.equal(checkpoint.checkpoint.order.inputCommitment, snapshotCommitment(checkpoint.checkpoint.order.snapshot));
});

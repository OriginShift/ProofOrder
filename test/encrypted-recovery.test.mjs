import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBytes, solidityPackedKeccak256, Wallet } from "ethers";
import { buildEvidence } from "../src/evidence.mjs";
import { evaluateAllocation } from "../src/evaluator.mjs";
import { ORDER_CONSTANTS, orderDigest, snapshotCommitment } from "../src/order.mjs";
import {
  createEncryptedRecoveryBundle, loadRecoveryBundle, recoverEncryptedResult,
  saveRecoveryBundle, verifyEncryptedRecoveryBundle,
} from "../src/recovery.mjs";
import { generateRecipientKeyPair, sealResult, sealedResultCommitment } from "../src/sealed-result.mjs";

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const randomHex = () => `0x${randomBytes(32).toString("hex")}`;
const verifier = Wallet.createRandom();
const buyer = Wallet.createRandom();
const serviceProvider = Wallet.createRandom();
const contractAddress = Wallet.createRandom().address;
const snapshot = {
  id: "fixed-snapshot-001",
  targets: [
    { id: "target-a", liquidityBps: 9000, scoreBps: 8200 },
    { id: "target-b", liquidityBps: 8000, scoreBps: 7600 },
  ],
};
const result = { allocations: [
  { target: "target-a", amountMinorUnits: 6000 },
  { target: "target-b", amountMinorUnits: 4000 },
] };
const evaluation = evaluateAllocation({ snapshot, ...result });

async function fixture({ changeOrder, plaintext, signedEvaluation = evaluation, create = true } = {}) {
  const recipient = await generateRecipientKeyPair();
  const orderId = randomHex();
  const order = {
    ...ORDER_CONSTANTS,
    orderId,
    nonce: randomHex(),
    settlementContract: contractAddress,
    buyer: buyer.address,
    provider: serviceProvider.address,
    payee: serviceProvider.address,
    verifierVersion: "ecdsa-evaluator-v1",
    paymentAsset: "native",
    feeMinorUnits: "1000000000000000000",
    deadline: 1_900_000_000,
    snapshot: structuredClone(snapshot),
    recipientPublicKey: recipient.publicKey,
    verifierAddress: verifier.address,
  };
  changeOrder?.(order);
  order.inputCommitment = snapshotCommitment(order.snapshot);
  const digest = `sha256:${Buffer.from(await orderDigest(order)).toString("hex")}`;
  const sealedResult = await sealResult({
    plaintext: plaintext ?? Buffer.from(JSON.stringify(result)),
    recipientPublicKey: recipient.publicKey,
    orderDigest: `0x${digest.slice(7)}`,
  });
  const commitment = `sha256:${sealedResultCommitment(sealedResult).slice(2)}`;
  const evidence = buildEvidence({ orderDigest: digest, ciphertextCommitment: commitment, evaluation: signedEvaluation });
  const messageHash = solidityPackedKeccak256(
    ["string", "address", "bytes32", "bytes32", "bytes32", "bytes32"],
    ["ProofOrder/VerificationEvidence/v1", contractAddress, orderId, `0x${digest.slice(7)}`,
      `0x${commitment.slice(7)}`, `0x${evidence.evidenceDigest.slice(7)}`],
  );
  const signature = await verifier.signMessage(getBytes(messageHash));
  const bundle = create
    ? await createEncryptedRecoveryBundle({ orderId, order, sealedResult, evidence, signature, verifierAddress: verifier.address })
    : { schemaVersion: 2, orderId, order, orderDigest: digest, sealedResult, ciphertextCommitment: commitment, evidence,
      attestation: { signature, verifierAddress: verifier.address }, chain: { chainId: order.chainId, contractAddress } };
  const trust = {
    expectedOrderId: orderId,
    expectedOrderDigest: digest,
    expectedChainId: order.chainId,
    expectedContractAddress: contractAddress,
    expectedVerifierAddress: verifier.address,
  };
  return { bundle, trust, recipient };
}

const original = await fixture();

test("encrypted recovery verifies signed metadata and independently evaluates decrypted allocations", async () => {
  const verified = await verifyEncryptedRecoveryBundle(original.bundle, original.trust);
  assert.equal(verified.ok, true);
  assert.equal(verified.verifierAddress, verifier.address);
  const recovered = await recoverEncryptedResult(original.bundle, { ...original.trust, recipientPrivateKey: original.recipient.privateKey });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.result, result);
  assert.deepEqual(recovered.evaluation, evaluation);
  assert.equal(JSON.stringify(original.bundle).includes(original.recipient.privateKey), false);
  assert.equal(Object.hasOwn(original.bundle, "ciphertext"), false);
});

test("recovery requires independent complete trust anchors", async () => {
  assert.deepEqual(await verifyEncryptedRecoveryBundle(original.bundle), { ok: false, code: "INVALID_TRUST" });
  for (const field of Object.keys(original.trust)) {
    const incomplete = { ...original.trust };
    delete incomplete[field];
    assert.deepEqual(await verifyEncryptedRecoveryBundle(original.bundle, incomplete), { ok: false, code: "INVALID_TRUST" }, field);
  }
});

test("recovery accepts reordered snapshot fields without changing the signed order", async () => {
  const bundle = structuredClone(original.bundle);
  bundle.order.snapshot = {
    targets: bundle.order.snapshot.targets.map((target) => Object.fromEntries(Object.entries(target).reverse())),
    id: bundle.order.snapshot.id,
  };
  assert.equal(snapshotCommitment(bundle.order.snapshot), original.bundle.order.inputCommitment);
  assert.deepEqual(await orderDigest(bundle.order), await orderDigest(original.bundle.order));
  assert.equal((await verifyEncryptedRecoveryBundle(bundle, original.trust)).ok, true);
  const recovered = await recoverEncryptedResult(bundle, { ...original.trust, recipientPrivateKey: original.recipient.privateKey });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.result, result);
});

for (const [field, value, code] of [
  ["expectedOrderId", randomHex(), "ORDER_ID_MISMATCH"],
  ["expectedOrderDigest", hash("another order"), "ORDER_DIGEST_MISMATCH"],
  ["expectedChainId", 1, "CHAIN_MISMATCH"],
  ["expectedContractAddress", buyer.address, "CHAIN_MISMATCH"],
  ["expectedVerifierAddress", buyer.address, "VERIFIER_MISMATCH"],
]) {
  test(`recovery rejects wrong trusted ${field}`, async () => {
    assert.deepEqual(await verifyEncryptedRecoveryBundle(original.bundle, { ...original.trust, [field]: value }), { ok: false, code });
  });
}

for (const [name, mutate, code] of [
  ["order fee", (bundle) => { bundle.order.feeMinorUnits = "2"; }, "ORDER_DIGEST_MISMATCH"],
  ["input commitment", (bundle) => { bundle.order.snapshot.targets[0].scoreBps = 9999; }, "INVALID_ORDER"],
  ["chain metadata", (bundle) => { bundle.chain.chainId = 1; }, "CHAIN_MISMATCH"],
  ["verifier metadata", (bundle) => { bundle.attestation.verifierAddress = buyer.address; }, "VERIFIER_MISMATCH"],
  ["envelope recipient", (bundle) => { bundle.sealedResult.recipientPublicKey = Buffer.alloc(32, 7).toString("base64"); }, "RECIPIENT_MISMATCH"],
  ["envelope order", (bundle) => { bundle.sealedResult.orderDigest = randomHex(); }, "ENVELOPE_ORDER_MISMATCH"],
  ["envelope encapsulation", (bundle) => { bundle.sealedResult.enc = Buffer.alloc(32, 7).toString("base64"); }, "CIPHERTEXT_COMMITMENT_MISMATCH"],
  ["envelope schema", (bundle) => { bundle.sealedResult.privateKey = "extra"; }, "INVALID_SEALED_RESULT"],
  ["evidence proof system", (bundle) => { bundle.evidence.proofSystem = "zk-proof"; }, "EVIDENCE_MISMATCH"],
  ["evidence verifier ID", (bundle) => { bundle.evidence.verifierId = "other"; }, "EVIDENCE_MISMATCH"],
  ["evidence public inputs", (bundle) => { delete bundle.evidence.publicInputs.orderDigest; }, "EVIDENCE_MISMATCH"],
  ["evidence digest", (bundle) => { bundle.evidence.evidenceDigest = hash("tampered"); }, "EVIDENCE_MISMATCH"],
  ["signature", (bundle) => { bundle.attestation.signature = `0x${"00".repeat(64)}1b`; }, "INVALID_SIGNATURE"],
  ["contract incompatible signature v", (bundle) => { bundle.attestation.signature = `${bundle.attestation.signature.slice(0, -2)}00`; }, "INVALID_SIGNATURE"],
  ["extra private key field", (bundle) => { bundle.recipientPrivateKey = original.recipient.privateKey; }, "INVALID_BUNDLE"],
]) {
  test(`recovery rejects mutation of ${name}`, async () => {
    const bundle = structuredClone(original.bundle);
    mutate(bundle);
    assert.deepEqual(await verifyEncryptedRecoveryBundle(bundle, original.trust), { ok: false, code });
  });
}

test("rewriting all envelope and evidence hashes cannot replace the verifier signature", async () => {
  const bundle = structuredClone(original.bundle);
  const ciphertext = Buffer.from(bundle.sealedResult.ciphertext, "base64");
  ciphertext[0] ^= 1;
  bundle.sealedResult.ciphertext = ciphertext.toString("base64");
  bundle.ciphertextCommitment = `sha256:${sealedResultCommitment(bundle.sealedResult).slice(2)}`;
  bundle.evidence = buildEvidence({ ...bundle, evaluation: bundle.evidence.evaluation });
  assert.deepEqual(await verifyEncryptedRecoveryBundle(bundle, original.trust), { ok: false, code: "INVALID_SIGNATURE" });
});

test("rewriting evaluation and evidence digest cannot replace the verifier signature", async () => {
  const bundle = structuredClone(original.bundle);
  bundle.evidence = buildEvidence({ ...bundle, evaluation: { ...evaluation, scoreBps: 9999 } });
  assert.deepEqual(await verifyEncryptedRecoveryBundle(bundle, original.trust), { ok: false, code: "INVALID_SIGNATURE" });
});

test("a different signer is rejected even when all bundle digests are valid", async () => {
  const bundle = structuredClone(original.bundle);
  const messageHash = solidityPackedKeccak256(
    ["string", "address", "bytes32", "bytes32", "bytes32", "bytes32"],
    ["ProofOrder/VerificationEvidence/v1", contractAddress, bundle.orderId, `0x${bundle.orderDigest.slice(7)}`,
      `0x${bundle.ciphertextCommitment.slice(7)}`, `0x${bundle.evidence.evidenceDigest.slice(7)}`],
  );
  bundle.attestation.signature = await buyer.signMessage(getBytes(messageHash));
  assert.deepEqual(await verifyEncryptedRecoveryBundle(bundle, original.trust), { ok: false, code: "INVALID_SIGNATURE" });
});

test("wrong recipient private key cannot decrypt a verified bundle", async () => {
  const other = await generateRecipientKeyPair();
  assert.deepEqual(await recoverEncryptedResult(original.bundle, { ...original.trust, recipientPrivateKey: other.privateKey }), { ok: false, code: "DECRYPTION_FAILED" });
});

for (const [name, plaintext, code] of [
  ["snapshot substitution", Buffer.from(JSON.stringify({ ...result, snapshot })), "INVALID_PLAINTEXT"],
  ["invalid UTF-8", Buffer.from([0xff]), "INVALID_PLAINTEXT"],
  ["non-JSON bytes", Buffer.from("broken"), "INVALID_PLAINTEXT"],
  ["additional allocation metadata", Buffer.from(JSON.stringify({ allocations: result.allocations.map((allocation) => ({ ...allocation, scoreBps: 10_000 })) })), "INVALID_PLAINTEXT"],
  ["invalid allocation amount", Buffer.from(JSON.stringify({ allocations: [{ target: "target-a", amountMinorUnits: "10000" }] })), "INVALID_PLAINTEXT"],
  ["unauthorized target", Buffer.from(JSON.stringify({ allocations: [{ target: "unknown", amountMinorUnits: 5000 }, { target: "target-b", amountMinorUnits: 5000 }] })), "RESULT_EVALUATION_FAILED"],
  ["different valid evaluation", Buffer.from(JSON.stringify({ allocations: [{ target: "target-a", amountMinorUnits: 5000 }, { target: "target-b", amountMinorUnits: 5000 }] })), "EVALUATION_MISMATCH"],
]) {
  test(`recovery rejects correctly signed ciphertext containing ${name}`, async () => {
    const current = await fixture({ plaintext });
    assert.equal((await verifyEncryptedRecoveryBundle(current.bundle, current.trust)).ok, true);
    assert.deepEqual(await recoverEncryptedResult(current.bundle, { ...current.trust, recipientPrivateKey: current.recipient.privateKey }), { ok: false, code });
  });
}

for (const [name, changeOrder] of [
  ["missing target score", (order) => { delete order.snapshot.targets[0].scoreBps; }],
  ["NaN score", (order) => { order.snapshot.targets[0].scoreBps = NaN; }],
  ["infinite liquidity", (order) => { order.snapshot.targets[0].liquidityBps = Infinity; }],
  ["out of range score", (order) => { order.snapshot.targets[0].scoreBps = 10001; }],
  ["negative liquidity", (order) => { order.snapshot.targets[0].liquidityBps = -1; }],
  ["duplicate snapshot targets", (order) => { order.snapshot.targets[1].id = "target-a"; }],
  ["unfrozen task", (order) => { order.taskType = "other"; }],
  ["unfrozen rule", (order) => { order.ruleId = "other"; }],
  ["unexpected verifier version", (order) => { order.verifierVersion = "g0-binding-experiment-v1"; }],
  ["numeric payment amount", (order) => { order.feeMinorUnits = 1; }],
  ["overflowing payment amount", (order) => { order.feeMinorUnits = (2n ** 256n).toString(); }],
  ["missing contract address", (order) => { delete order.settlementContract; }],
  ["invalid deadline", (order) => { order.deadline = NaN; }],
]) {
  test(`a signed order still rejects ${name}`, async () => {
    const current = await fixture({ changeOrder, create: false });
    assert.deepEqual(await verifyEncryptedRecoveryBundle(current.bundle, current.trust), { ok: false, code: "INVALID_ORDER" });
  });
}

test("creation rejects missing attestation and prevents caller mutations from changing the bundle", async () => {
  const source = structuredClone(original.bundle);
  await assert.rejects(createEncryptedRecoveryBundle({ ...source, verifierAddress: verifier.address }), { code: "INVALID_SIGNATURE" });
  const created = await createEncryptedRecoveryBundle({ ...source, ...source.attestation });
  source.order.feeMinorUnits = "1";
  source.evidence.evaluation.scoreBps = 10000;
  assert.equal(created.order.feeMinorUnits, "1000000000000000000");
  assert.equal(created.evidence.evaluation.scoreBps, evaluation.scoreBps);
});

test("recovery snapshots its inputs before asynchronous checks", async () => {
  const bundle = structuredClone(original.bundle);
  const pending = recoverEncryptedResult(bundle, { ...original.trust, recipientPrivateKey: original.recipient.privateKey });
  bundle.order.snapshot.targets[0].scoreBps = 10_000;
  bundle.evidence.evaluation.scoreBps = 10_000;
  assert.equal((await pending).ok, true);
});

test("atomic durable bundle writes preserve JSON, restrict permissions and clean failed temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prooforder-recovery-"));
  try {
    const path = join(directory, "bundle.json");
    await saveRecoveryBundle(path, original.bundle);
    assert.deepEqual(await loadRecoveryBundle(path), original.bundle);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await recoverEncryptedResult(await loadRecoveryBundle(path), { ...original.trust, recipientPrivateKey: original.recipient.privateKey })).ok, true);
    const circular = {};
    circular.self = circular;
    await assert.rejects(saveRecoveryBundle(path, circular), TypeError);
    assert.deepEqual(await loadRecoveryBundle(path), original.bundle);
    assert.deepEqual(await readdir(directory), ["bundle.json"]);
    await saveRecoveryBundle(path, { schemaVersion: 1, replaced: true });
    assert.deepEqual(await loadRecoveryBundle(path), { schemaVersion: 1, replaced: true });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

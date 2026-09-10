import assert from "node:assert/strict";
import test from "node:test";
import { createRecoveryBundle, verifyRecoveryBundle } from "../src/recovery.mjs";

const bundle = createRecoveryBundle({
  order: { nonce: 1 },
  orderDigest: "sha256:order",
  ciphertext: Buffer.from("sealed-result"),
  evidence: { publicInputs: { orderDigest: "sha256:order", ciphertextCommitment: "sha256:6585825ffb473e9a9e48848a5ae4bbba922ab6245684b3a20f8b1f2969c34c33" } },
  chainId: 31337,
  contractAddress: "0x0000000000000000000000000000000000000001",
  retrieval: { kind: "local-file", locator: "artifacts/demo-recovery-bundle.json" },
});

test("recovery bundle validates its persisted ciphertext commitment", () => {
  const result = verifyRecoveryBundle(bundle);
  assert.equal(result.ok, true);
  assert.equal(result.ciphertext.toString(), "sealed-result");
});

test("recovery bundle rejects ciphertext mutation", () => {
  const tampered = { ...bundle, ciphertext: Buffer.from("tampered").toString("base64") };
  assert.deepEqual(verifyRecoveryBundle(tampered), { ok: false, code: "CIPHERTEXT_COMMITMENT_MISMATCH" });
});

test("recovery bundle rejects mismatched order evidence", () => {
  const tampered = { ...bundle, evidence: { publicInputs: { ...bundle.evidence.publicInputs, orderDigest: "sha256:other" } } };
  assert.deepEqual(verifyRecoveryBundle(tampered), { ok: false, code: "ORDER_DIGEST_MISMATCH" });
});

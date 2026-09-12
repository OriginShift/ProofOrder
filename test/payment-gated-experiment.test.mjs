import assert from "node:assert/strict";
import test from "node:test";
import {
  createPaymentGatedEnvelope,
  openPaymentGatedResult,
  publicPaymentGatedEnvelope,
  releasePaymentKey,
} from "../src/payment-gated-experiment.mjs";

const orderDigest = `0x${"11".repeat(32)}`;
const plaintext = Buffer.from(JSON.stringify({ answer: "only after settlement" }));

test("payment-gated bundle cannot decrypt before key release", () => {
  const envelope = createPaymentGatedEnvelope({ plaintext, orderDigest });
  const publicBundle = publicPaymentGatedEnvelope(envelope);
  assert.equal(Object.hasOwn(publicBundle, "_releaseKey"), false);
  assert.equal(JSON.stringify(publicBundle).includes("only after settlement"), false);
  assert.throws(() => openPaymentGatedResult({ envelope: publicBundle, expectedOrderDigest: orderDigest }), (error) => {
    assert.equal(error.code, "KEY_UNAVAILABLE");
    return true;
  });
});

test("settlement-side key release decrypts and binds the order and ciphertext", () => {
  const envelope = createPaymentGatedEnvelope({ plaintext, orderDigest });
  const releasedKey = releasePaymentKey(envelope);
  assert.deepEqual(Buffer.from(openPaymentGatedResult({ envelope, releasedKey, expectedOrderDigest: orderDigest })), plaintext);
  assert.throws(() => openPaymentGatedResult({ envelope, releasedKey, expectedOrderDigest: `0x${"22".repeat(32)}` }), (error) => {
    assert.equal(error.code, "ORDER_DIGEST_MISMATCH");
    return true;
  });
  assert.throws(() => openPaymentGatedResult({ envelope, releasedKey: Buffer.alloc(32).toString("base64"), expectedOrderDigest: orderDigest }), (error) => {
    assert.equal(error.code, "KEY_COMMITMENT_MISMATCH");
    return true;
  });
});

test("provider withholding after settlement remains an explicit liveness failure", () => {
  const envelope = createPaymentGatedEnvelope({ plaintext, orderDigest });
  const publicBundle = publicPaymentGatedEnvelope(envelope);
  assert.throws(() => openPaymentGatedResult({ envelope: publicBundle, expectedOrderDigest: orderDigest }), (error) => {
    assert.equal(error.code, "KEY_UNAVAILABLE");
    return true;
  });
});

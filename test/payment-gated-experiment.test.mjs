import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PaymentGatedError,
  createPaymentGatedEnvelope,
  openPaymentGatedResult,
  paymentGatedCommitment,
  validatePaymentGatedEnvelope,
} from "../src/payment-gated-experiment.mjs";

const orderDigest = `0x${"11".repeat(32)}`;
const otherOrderDigest = `0x${"22".repeat(32)}`;
const plaintext = Buffer.from(JSON.stringify({ answer: "deferred-key experiment" }));
const fields = ["version", "suite", "orderDigest", "iv", "ciphertext", "tag", "keyCommitment"];

function fixture(input = plaintext) {
  const { envelope, providerSecret } = createPaymentGatedEnvelope({ plaintext: input, orderDigest });
  return {
    envelope,
    releasedKey: providerSecret.releasedKey,
    expectedOrderDigest: orderDigest,
    expectedEnvelopeCommitment: paymentGatedCommitment(envelope),
  };
}

function hasCode(code) {
  return (error) => {
    assert.ok(error instanceof PaymentGatedError);
    assert.equal(error.code, code);
    return true;
  };
}

function flipBase64(value) {
  const bytes = Buffer.from(value, "base64");
  bytes[0] ^= 1;
  return bytes.toString("base64");
}

test("creation separates the public envelope and provider secret by construction", () => {
  const { envelope, providerSecret } = createPaymentGatedEnvelope({ plaintext, orderDigest });
  assert.deepEqual(Reflect.ownKeys(envelope), fields);
  assert.deepEqual(Reflect.ownKeys(providerSecret), ["releasedKey"]);
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes(providerSecret.releasedKey), false);
  assert.equal(serialized.includes(plaintext.toString()), false);
  assert.equal(serialized.includes(plaintext.toString("base64")), false);
  assert.equal(envelope.version, 1);
  assert.equal(envelope.suite, "AES-256-GCM");
});

test("a JSON-round-tripped envelope opens with both externally pinned values", () => {
  const input = fixture();
  input.envelope = JSON.parse(JSON.stringify(input.envelope));
  assert.deepEqual(Buffer.from(openPaymentGatedResult(input)), plaintext);
});

test("empty plaintext remains authenticated and round-trips", () => {
  const input = fixture(new Uint8Array());
  assert.equal(input.envelope.ciphertext, "");
  assert.deepEqual(openPaymentGatedResult(input), new Uint8Array());
});

test("encryption of the same order and plaintext uses fresh keys and IVs", () => {
  const first = fixture();
  const second = fixture();
  assert.notEqual(first.releasedKey, second.releasedKey);
  assert.notEqual(first.envelope.iv, second.envelope.iv);
  assert.notEqual(first.envelope.ciphertext, second.envelope.ciphertext);
  assert.notEqual(first.expectedEnvelopeCommitment, second.expectedEnvelopeCommitment);
});

test("the commitment normalizes property order and a null object prototype", () => {
  const { envelope } = fixture();
  const reordered = Object.fromEntries(Object.entries(envelope).reverse());
  const nullPrototype = Object.assign(Object.create(null), reordered);
  assert.equal(paymentGatedCommitment(reordered), paymentGatedCommitment(envelope));
  assert.equal(paymentGatedCommitment(nullPrototype), paymentGatedCommitment(envelope));
  const normalized = validatePaymentGatedEnvelope(envelope);
  envelope.iv = Buffer.alloc(12).toString("base64");
  assert.notEqual(normalized.iv, envelope.iv);
});

test("a missing key stays unavailable, independent of payment or elapsed time", () => {
  const input = fixture();
  delete input.releasedKey;
  assert.throws(() => openPaymentGatedResult(input), hasCode("KEY_UNAVAILABLE"));
  assert.throws(() => openPaymentGatedResult({ ...input, releasedKey: null }), hasCode("KEY_UNAVAILABLE"));
});

test("an early provider release already decrypts; this primitive does not enforce payment", () => {
  assert.deepEqual(Buffer.from(openPaymentGatedResult(fixture())), plaintext);
});

test("a canonical but different data key does not match the committed key", () => {
  const input = fixture();
  input.releasedKey = flipBase64(input.releasedKey);
  assert.throws(() => openPaymentGatedResult(input), hasCode("KEY_COMMITMENT_MISMATCH"));
});

test("a mismatched expected order cannot open the envelope", () => {
  assert.throws(() => openPaymentGatedResult({ ...fixture(), expectedOrderDigest: otherOrderDigest }), hasCode("ORDER_DIGEST_MISMATCH"));
});

test("a mismatched externally pinned envelope commitment cannot open the envelope", () => {
  assert.throws(() => openPaymentGatedResult({ ...fixture(), expectedEnvelopeCommitment: otherOrderDigest }), hasCode("ENVELOPE_COMMITMENT_MISMATCH"));
});

test("an attacker cannot replace the key commitment and envelope using its own key", () => {
  const honest = fixture();
  const substituted = fixture(Buffer.from("attacker-controlled result"));
  assert.throws(() => openPaymentGatedResult({
    ...honest, envelope: substituted.envelope, releasedKey: substituted.releasedKey,
  }), hasCode("ENVELOPE_COMMITMENT_MISMATCH"));
  assert.notEqual(paymentGatedCommitment(substituted.envelope), honest.expectedEnvelopeCommitment);
});

test("an attacker-supplied commitment field inside an envelope is rejected", () => {
  const input = fixture();
  input.envelope.envelopeCommitment = input.expectedEnvelopeCommitment;
  assert.throws(() => openPaymentGatedResult(input), hasCode("INVALID_ENVELOPE"));
});

for (const field of ["iv", "ciphertext", "tag"]) {
  test(`a changed ${field} is rejected by the pinned commitment`, () => {
    const input = fixture();
    input.envelope[field] = flipBase64(input.envelope[field]);
    assert.throws(() => openPaymentGatedResult(input), hasCode("ENVELOPE_COMMITMENT_MISMATCH"));
  });

  test(`AES authentication rejects a changed ${field} even with its replacement commitment`, () => {
    const input = fixture();
    input.envelope[field] = flipBase64(input.envelope[field]);
    input.expectedEnvelopeCommitment = paymentGatedCommitment(input.envelope);
    assert.throws(() => openPaymentGatedResult(input), hasCode("DECRYPTION_FAILED"));
  });
}

test("authenticated metadata prevents rewrapping unchanged ciphertext for another order", () => {
  const input = fixture();
  input.envelope.orderDigest = otherOrderDigest;
  input.envelope.keyCommitment = `0x${createHash("sha256")
    .update(`ProofOrder/PaymentGatedDisclosure/v1/key|${otherOrderDigest}|`)
    .update(Buffer.from(input.releasedKey, "base64")).digest("hex")}`;
  input.expectedOrderDigest = otherOrderDigest;
  input.expectedEnvelopeCommitment = paymentGatedCommitment(input.envelope);
  assert.throws(() => openPaymentGatedResult(input), hasCode("DECRYPTION_FAILED"));
});

test("the key commitment is included in the externally pinned envelope commitment", () => {
  const input = fixture();
  input.envelope.keyCommitment = otherOrderDigest;
  assert.throws(() => openPaymentGatedResult(input), hasCode("ENVELOPE_COMMITMENT_MISMATCH"));
});

test("every public field contributes to the commitment or is rejected as unsupported", () => {
  const input = fixture();
  const candidates = {
    orderDigest: otherOrderDigest,
    iv: flipBase64(input.envelope.iv),
    ciphertext: flipBase64(input.envelope.ciphertext),
    tag: flipBase64(input.envelope.tag),
    keyCommitment: otherOrderDigest,
  };
  for (const [field, value] of Object.entries(candidates)) {
    assert.notEqual(paymentGatedCommitment({ ...input.envelope, [field]: value }), input.expectedEnvelopeCommitment, field);
  }
  for (const patch of [{ version: 2 }, { suite: "AES-128-GCM" }]) {
    assert.throws(() => paymentGatedCommitment({ ...input.envelope, ...patch }), hasCode("UNSUPPORTED_SUITE"));
  }
});

test("envelope validation rejects omitted, extra, inherited, symbol and accessor fields", () => {
  const { envelope } = fixture();
  const omitted = { ...envelope };
  delete omitted.tag;
  const inherited = Object.assign(Object.create({ leaked: true }), envelope);
  const symbol = { ...envelope, [Symbol("hidden")]: true };
  const accessor = { ...envelope };
  let getterCalls = 0;
  Object.defineProperty(accessor, "iv", { enumerable: true, get() { getterCalls += 1; return envelope.iv; } });
  for (const invalid of [undefined, null, [], "envelope", omitted, inherited, symbol, accessor, { ...envelope, _releaseKey: "secret" }]) {
    assert.throws(() => validatePaymentGatedEnvelope(invalid), hasCode("INVALID_ENVELOPE"));
  }
  assert.equal(getterCalls, 0);
});

test("schema scalar values cannot be objects with coercion hooks", () => {
  const { envelope } = fixture();
  let coercions = 0;
  const fake = { toString() { coercions += 1; return envelope.iv; } };
  assert.throws(() => validatePaymentGatedEnvelope({ ...envelope, iv: fake }), hasCode("INVALID_BASE64"));
  assert.throws(() => validatePaymentGatedEnvelope({ ...envelope, version: new Number(1) }), hasCode("UNSUPPORTED_SUITE"));
  assert.equal(coercions, 0);
});

test("base64 decoding rejects whitespace, omitted padding, URL alphabet and noncanonical pad bits", () => {
  const { envelope } = fixture();
  for (const iv of [" AA==", "AA", "AA==\n", "__8=", "AB==", 123, null]) {
    assert.throws(() => validatePaymentGatedEnvelope({ ...envelope, iv }), hasCode("INVALID_BASE64"));
  }
});

test("nonce, authentication tag and key lengths are fixed", () => {
  const input = fixture();
  for (const [field, length] of [["iv", 11], ["iv", 13], ["tag", 15], ["tag", 17]]) {
    assert.throws(() => validatePaymentGatedEnvelope({ ...input.envelope, [field]: Buffer.alloc(length).toString("base64") }), hasCode("INVALID_LENGTH"));
  }
  for (const length of [0, 31, 33]) {
    assert.throws(() => openPaymentGatedResult({ ...input, releasedKey: Buffer.alloc(length).toString("base64") }), hasCode("INVALID_LENGTH"));
  }
  for (const releasedKey of ["not a key", 1, {}, input.releasedKey.slice(0, -1)]) {
    assert.throws(() => openPaymentGatedResult({ ...input, releasedKey }), hasCode("INVALID_BASE64"));
  }
});

test("order digests and commitments require canonical 32-byte lowercase hex", () => {
  const input = fixture();
  for (const value of [undefined, null, 1, "0X" + "11".repeat(32), "0x" + "AA".repeat(32), "0x11", "sha256:" + "11".repeat(32)]) {
    assert.throws(() => openPaymentGatedResult({ ...input, expectedOrderDigest: value }), hasCode("INVALID_ORDER_DIGEST"));
    assert.throws(() => openPaymentGatedResult({ ...input, expectedEnvelopeCommitment: value }), hasCode("INVALID_COMMITMENT"));
    assert.throws(() => validatePaymentGatedEnvelope({ ...input.envelope, keyCommitment: value }), hasCode("INVALID_COMMITMENT"));
  }
});

test("both trusted context values are mandatory and are not taken from the envelope", () => {
  const input = fixture();
  for (const field of ["expectedOrderDigest", "expectedEnvelopeCommitment"]) {
    const missing = { ...input };
    delete missing[field];
    assert.throws(() => openPaymentGatedResult(missing), hasCode("INVALID_ARGUMENTS"));
  }
});

test("malformed function argument objects use stable errors without evaluating accessors", () => {
  for (const input of [undefined, null, [], "input", {}]) {
    assert.throws(() => createPaymentGatedEnvelope(input), hasCode("INVALID_ARGUMENTS"));
    assert.throws(() => openPaymentGatedResult(input), hasCode("INVALID_ARGUMENTS"));
  }
  const options = { plaintext, orderDigest };
  Object.defineProperty(options, "plaintext", { get() { throw new Error("must not execute"); } });
  assert.throws(() => createPaymentGatedEnvelope(options), hasCode("INVALID_ARGUMENTS"));
  for (const invalid of ["plaintext", [], null, {}, new ArrayBuffer(2)]) {
    assert.throws(() => createPaymentGatedEnvelope({ plaintext: invalid, orderDigest }), hasCode("INVALID_PLAINTEXT"));
  }
});

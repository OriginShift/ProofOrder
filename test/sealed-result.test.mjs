import assert from "node:assert/strict";
import test from "node:test";
import {
  SEALED_RESULT_SUITE,
  SealedResultError,
  deserializeRecipientPrivateKey,
  deserializeRecipientPublicKey,
  generateRecipientKeyPair,
  openSealedResult,
  sealResult,
  sealedResultCommitment,
  serializeRecipientPrivateKey,
  serializeRecipientPublicKey,
  validateSealedResult,
} from "../src/sealed-result.mjs";

const orderDigest = `0x${"12".repeat(32)}`;
const otherOrderDigest = `0x${"34".repeat(32)}`;
const plaintext = Uint8Array.from([0, 1, 127, 128, 255, 4, 0, 9]);
const recipient = await generateRecipientKeyPair();
const otherRecipient = await generateRecipientKeyPair();
const envelope = await sealResult({ plaintext, recipientPublicKey: recipient.publicKey, orderDigest });
const open = (sealedResult = envelope, overrides = {}) => openSealedResult({
  sealedResult,
  recipientPrivateKey: recipient.privateKey,
  expectedOrderDigest: orderDigest,
  ...overrides,
});
const errorCode = (code) => (error) => error instanceof SealedResultError && error.code === code;
const mutateBase64 = (value) => {
  const bytes = Buffer.from(value, "base64");
  bytes[0] ^= 1;
  return bytes.toString("base64");
};

test("HPKE sealed result roundtrips arbitrary bytes after JSON persistence", async () => {
  assert.deepEqual(await open(JSON.parse(JSON.stringify(envelope))), plaintext);
  assert.equal(envelope.suite, SEALED_RESULT_SUITE);
  assert.equal(Buffer.from(envelope.enc, "base64").length, 32);
  assert.equal(Buffer.from(envelope.ciphertext, "base64").length, plaintext.length + 16);
  assert.deepEqual(Object.keys(envelope), ["version", "suite", "orderDigest", "recipientPublicKey", "enc", "ciphertext"]);
  assert.equal(JSON.stringify(envelope).includes(recipient.privateKey), false);
  assert.notDeepEqual(Buffer.from(envelope.ciphertext, "base64"), Buffer.from(plaintext));
});

test("recipient public and private keys have lossless separate serialization", async () => {
  assert.equal(await serializeRecipientPublicKey(await deserializeRecipientPublicKey(recipient.publicKey)), recipient.publicKey);
  assert.equal(await serializeRecipientPrivateKey(await deserializeRecipientPrivateKey(recipient.privateKey)), recipient.privateKey);
  assert.equal(Buffer.from(recipient.publicKey, "base64").length, 32);
  assert.equal(Buffer.from(recipient.privateKey, "base64").length, 32);
});

test("HPKE uses fresh encapsulation for the same plaintext and order", async () => {
  const repeated = await sealResult({ plaintext, recipientPublicKey: recipient.publicKey, orderDigest });
  assert.notEqual(repeated.enc, envelope.enc);
  assert.notEqual(repeated.ciphertext, envelope.ciphertext);
  assert.notEqual(sealedResultCommitment(repeated), sealedResultCommitment(envelope));
  assert.deepEqual(await open(repeated), plaintext);
});

test("HPKE supports an empty byte payload", async () => {
  const empty = await sealResult({ plaintext: new Uint8Array(), recipientPublicKey: recipient.publicKey, orderDigest });
  assert.deepEqual(await open(empty), new Uint8Array());
});

test("opening requires a trusted order digest outside the envelope", async () => {
  await assert.rejects(open(envelope, { expectedOrderDigest: undefined }), errorCode("INVALID_ORDER_DIGEST"));
  await assert.rejects(open(envelope, { expectedOrderDigest: otherOrderDigest }), errorCode("ORDER_DIGEST_MISMATCH"));
  await assert.rejects(open({ ...envelope, orderDigest: otherOrderDigest }), errorCode("ORDER_DIGEST_MISMATCH"));
  await assert.rejects(open({ ...envelope, orderDigest: otherOrderDigest }, { expectedOrderDigest: otherOrderDigest }), errorCode("DECRYPTION_FAILED"));
});

test("ciphertext and encapsulated key tampering fail authenticated decryption", async () => {
  for (const field of ["ciphertext", "enc"]) {
    const tampered = { ...envelope, [field]: mutateBase64(envelope[field]) };
    assert.notEqual(sealedResultCommitment(tampered), sealedResultCommitment(envelope));
    await assert.rejects(open(tampered), errorCode("DECRYPTION_FAILED"));
  }
});

test("recipient public key metadata and private key substitution are rejected", async () => {
  await assert.rejects(open({ ...envelope, recipientPublicKey: otherRecipient.publicKey }), errorCode("DECRYPTION_FAILED"));
  await assert.rejects(open(envelope, { recipientPrivateKey: otherRecipient.privateKey }), errorCode("DECRYPTION_FAILED"));
  await assert.rejects(open({ ...envelope, recipientPublicKey: otherRecipient.publicKey }, { recipientPrivateKey: otherRecipient.privateKey }), errorCode("DECRYPTION_FAILED"));
});

test("envelope commitment binds canonical metadata and ciphertext without depending on property order", () => {
  const commitment = sealedResultCommitment(envelope);
  assert.match(commitment, /^0x[0-9a-f]{64}$/);
  assert.equal(sealedResultCommitment(Object.fromEntries(Object.entries(envelope).reverse())), commitment);
  for (const mutation of [
    { orderDigest: otherOrderDigest },
    { recipientPublicKey: otherRecipient.publicKey },
    { enc: mutateBase64(envelope.enc) },
    { ciphertext: mutateBase64(envelope.ciphertext) },
  ]) {
    assert.notEqual(sealedResultCommitment({ ...envelope, ...mutation }), commitment);
  }
});

test("sealed result schema rejects extra, missing, inherited and accessor fields", async () => {
  const { enc, ...missing } = envelope;
  const getter = { ...envelope };
  Object.defineProperty(getter, "ciphertext", { get: () => envelope.ciphertext });
  const symbol = { ...envelope, [Symbol("extra")]: true };
  for (const malformed of [null, [], "envelope", missing, { ...envelope, privateKey: recipient.privateKey }, Object.create(envelope), getter, symbol]) {
    assert.throws(() => validateSealedResult(malformed), errorCode("INVALID_ENVELOPE"));
    await assert.rejects(open(malformed), errorCode("INVALID_ENVELOPE"));
  }
});

test("unsupported version and suite are rejected by both opening and commitment", async () => {
  for (const mutation of [{ version: 2 }, { version: "1" }, { suite: "AES-128-GCM" }]) {
    const changed = { ...envelope, ...mutation };
    assert.throws(() => sealedResultCommitment(changed), errorCode("UNSUPPORTED_SUITE"));
    await assert.rejects(open(changed), errorCode("UNSUPPORTED_SUITE"));
  }
});

test("canonical padded base64 is required for every binary envelope field", async () => {
  for (const field of ["recipientPublicKey", "enc", "ciphertext"]) {
    for (const malformed of ["a===", "!!!!", "YQ", "YR==", `${envelope[field]}\n`, ` ${envelope[field]}`, 42]) {
      await assert.rejects(open({ ...envelope, [field]: malformed }), errorCode("INVALID_BASE64"));
    }
  }
  await assert.rejects(deserializeRecipientPrivateKey(`${recipient.privateKey}\n`), errorCode("INVALID_BASE64"));
});

test("key, encapsulation and authentication tag lengths are enforced", async () => {
  for (const field of ["recipientPublicKey", "enc"]) {
    for (const size of [0, 31, 33]) {
      await assert.rejects(open({ ...envelope, [field]: Buffer.alloc(size).toString("base64") }), errorCode("INVALID_LENGTH"));
    }
  }
  await assert.rejects(open({ ...envelope, ciphertext: Buffer.alloc(15).toString("base64") }), errorCode("INVALID_LENGTH"));
  await assert.rejects(deserializeRecipientPrivateKey(Buffer.alloc(31).toString("base64")), errorCode("INVALID_LENGTH"));
});

test("order digest has one canonical 32-byte representation", async () => {
  for (const malformed of ["12".repeat(32), `sha256:${"12".repeat(32)}`, `0x${"AB".repeat(32)}`, "0x12", new Uint8Array(32)]) {
    await assert.rejects(open({ ...envelope, orderDigest: malformed }), errorCode("INVALID_ORDER_DIGEST"));
    await assert.rejects(sealResult({ plaintext, recipientPublicKey: recipient.publicKey, orderDigest: malformed }), errorCode("INVALID_ORDER_DIGEST"));
  }
});

test("low-order X25519 recipient keys fail encryption with a stable error", async () => {
  await assert.rejects(sealResult({ plaintext, recipientPublicKey: Buffer.alloc(32).toString("base64"), orderDigest }), errorCode("ENCRYPTION_FAILED"));
});

test("sealing accepts byte payloads only", async () => {
  for (const malformed of [null, "plaintext", { result: true }, [1, 2, 3]]) {
    await assert.rejects(sealResult({ plaintext: malformed, recipientPublicKey: recipient.publicKey, orderDigest }), errorCode("INVALID_PLAINTEXT"));
  }
});

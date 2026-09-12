import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const DOMAIN = "ProofOrder/PaymentGatedDisclosure/v1";
const CIPHER_SUITE = "AES-256-GCM";

export class PaymentGatedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PaymentGatedError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PaymentGatedError(code, message);
}

function requireBytes(value, field) {
  if (!(value instanceof Uint8Array)) fail("INVALID_BYTES", `${field} must be bytes.`);
  return Buffer.from(value);
}

function requireDigest(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    fail("INVALID_ORDER_DIGEST", "Order digest must be a canonical lowercase 32-byte hex string.");
  }
  return value;
}

function base64(value, field, length) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail("INVALID_BASE64", `${field} must be canonical padded base64.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (length !== undefined && bytes.length !== length)) {
    fail("INVALID_BASE64", `${field} has an invalid encoding or length.`);
  }
  return bytes;
}

function commitment(kind, orderDigest, value) {
  return `0x${createHash("sha256").update(`${DOMAIN}/${kind}|${orderDigest}|`).update(value).digest("hex")}`;
}

export function createPaymentGatedEnvelope({ plaintext, orderDigest }) {
  const input = requireBytes(plaintext, "plaintext");
  const digest = requireDigest(orderDigest);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: VERSION,
    suite: CIPHER_SUITE,
    orderDigest: digest,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
    ciphertextCommitment: commitment("ciphertext", digest, Buffer.concat([iv, ciphertext, tag])),
    keyCommitment: commitment("key", digest, key),
    // Deliberately omitted: the data key is released only after settlement.
    _releaseKey: key,
  };
}

export function publicPaymentGatedEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") fail("INVALID_ENVELOPE", "Envelope must be an object.");
  const { _releaseKey: ignoredReleaseKey, ...publicEnvelope } = envelope;
  void ignoredReleaseKey;
  return publicEnvelope;
}

export function releasePaymentKey(envelope) {
  if (!envelope || !Buffer.isBuffer(envelope._releaseKey)) fail("KEY_UNAVAILABLE", "The provider has not released the data key.");
  return envelope._releaseKey.toString("base64");
}

export function openPaymentGatedResult({ envelope, releasedKey, expectedOrderDigest }) {
  if (!envelope || envelope.version !== VERSION || envelope.suite !== CIPHER_SUITE) {
    fail("INVALID_ENVELOPE", "Unsupported payment-gated envelope.");
  }
  const digest = requireDigest(expectedOrderDigest);
  if (envelope.orderDigest !== digest) fail("ORDER_DIGEST_MISMATCH", "Envelope does not belong to the expected order.");
  if (typeof releasedKey !== "string") fail("KEY_UNAVAILABLE", "The data key is not available before settlement release.");
  const key = base64(releasedKey, "releasedKey", 32);
  const expectedKeyCommitment = Buffer.from(envelope.keyCommitment.slice(2), "hex");
  const actualKeyCommitment = Buffer.from(commitment("key", digest, key).slice(2), "hex");
  if (expectedKeyCommitment.length !== actualKeyCommitment.length || !timingSafeEqual(expectedKeyCommitment, actualKeyCommitment)) {
    fail("KEY_COMMITMENT_MISMATCH", "Released key does not match the committed key.");
  }
  const iv = base64(envelope.iv, "iv", 12);
  const ciphertext = base64(envelope.ciphertext, "ciphertext");
  const tag = base64(envelope.tag, "tag", 16);
  const actualCiphertextCommitment = commitment("ciphertext", digest, Buffer.concat([iv, ciphertext, tag]));
  if (actualCiphertextCommitment !== envelope.ciphertextCommitment) fail("CIPHERTEXT_COMMITMENT_MISMATCH", "Ciphertext was changed.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch (cause) {
    throw new PaymentGatedError("DECRYPTION_FAILED", "Payment-gated ciphertext authentication failed.", { cause });
  }
}

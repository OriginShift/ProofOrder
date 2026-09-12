import { createHash } from "node:crypto";
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

export const SEALED_RESULT_VERSION = 1;
export const SEALED_RESULT_SUITE = "DHKEM(X25519, HKDF-SHA256)/HKDF-SHA256/AES-256-GCM";
const DOMAIN = "ProofOrder/SealedResult/v1";
const encoder = new TextEncoder();
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const info = encoder.encode(`${DOMAIN}|${SEALED_RESULT_SUITE}`);
const envelopeFields = ["version", "suite", "orderDigest", "recipientPublicKey", "enc", "ciphertext"];

export class SealedResultError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "SealedResultError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SealedResultError(code, message);
}

function validateOrderDigest(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    fail("INVALID_ORDER_DIGEST", "Order digest must be a canonical lowercase 32-byte hex string.");
  }
  return value;
}

function decodeBase64(value, field, { length, minimum = 0 } = {}) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail("INVALID_BASE64", `${field} must be canonical padded base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    fail("INVALID_BASE64", `${field} must be canonical padded base64.`);
  }
  if ((length !== undefined && decoded.length !== length) || decoded.length < minimum) {
    fail("INVALID_LENGTH", `${field} has an invalid byte length.`);
  }
  return decoded;
}

function metadata(envelope) {
  return {
    version: envelope.version,
    suite: envelope.suite,
    orderDigest: envelope.orderDigest,
    recipientPublicKey: envelope.recipientPublicKey,
  };
}

function additionalData(envelope) {
  return encoder.encode(`${DOMAIN}|${JSON.stringify(metadata(envelope))}`);
}

export function validateSealedResult(envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(envelope))) {
    fail("INVALID_ENVELOPE", "Sealed result must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(envelope);
  if (Reflect.ownKeys(descriptors).length !== envelopeFields.length
    || envelopeFields.some((field) => !descriptors[field] || !Object.hasOwn(descriptors[field], "value"))) {
    fail("INVALID_ENVELOPE", "Sealed result fields do not match its schema.");
  }
  const normalized = Object.fromEntries(envelopeFields.map((field) => [field, descriptors[field].value]));
  if (normalized.version !== SEALED_RESULT_VERSION || normalized.suite !== SEALED_RESULT_SUITE) {
    fail("UNSUPPORTED_SUITE", "Unsupported sealed result version or HPKE suite.");
  }
  validateOrderDigest(normalized.orderDigest);
  decodeBase64(normalized.recipientPublicKey, "recipientPublicKey", { length: 32 });
  decodeBase64(normalized.enc, "enc", { length: 32 });
  decodeBase64(normalized.ciphertext, "ciphertext", { minimum: 16 });
  return normalized;
}

export async function serializeRecipientPublicKey(key) {
  try {
    return Buffer.from(await suite.kem.serializePublicKey(key)).toString("base64");
  } catch (cause) {
    throw new SealedResultError("INVALID_PUBLIC_KEY", "Unable to serialize recipient public key.", { cause });
  }
}

export async function serializeRecipientPrivateKey(key) {
  try {
    return Buffer.from(await suite.kem.serializePrivateKey(key)).toString("base64");
  } catch (cause) {
    throw new SealedResultError("INVALID_PRIVATE_KEY", "Unable to serialize recipient private key.", { cause });
  }
}

export async function deserializeRecipientPublicKey(value) {
  const bytes = decodeBase64(value, "recipientPublicKey", { length: 32 });
  try {
    return await suite.kem.deserializePublicKey(bytes);
  } catch (cause) {
    throw new SealedResultError("INVALID_PUBLIC_KEY", "Unable to import recipient public key.", { cause });
  }
}

export async function deserializeRecipientPrivateKey(value) {
  const bytes = decodeBase64(value, "recipientPrivateKey", { length: 32 });
  try {
    return await suite.kem.deserializePrivateKey(bytes);
  } catch (cause) {
    throw new SealedResultError("INVALID_PRIVATE_KEY", "Unable to import recipient private key.", { cause });
  }
}

export async function generateRecipientKeyPair() {
  const keys = await suite.kem.generateKeyPair();
  return {
    publicKey: await serializeRecipientPublicKey(keys.publicKey),
    privateKey: await serializeRecipientPrivateKey(keys.privateKey),
  };
}

export async function sealResult({ plaintext, recipientPublicKey, orderDigest }) {
  if (!(plaintext instanceof Uint8Array)) {
    fail("INVALID_PLAINTEXT", "Plaintext must be a Uint8Array.");
  }
  const normalized = {
    version: SEALED_RESULT_VERSION,
    suite: SEALED_RESULT_SUITE,
    orderDigest: validateOrderDigest(orderDigest),
    recipientPublicKey,
  };
  const publicKey = await deserializeRecipientPublicKey(recipientPublicKey);
  try {
    const sender = await suite.createSenderContext({ recipientPublicKey: publicKey, info });
    const ciphertext = await sender.seal(plaintext, additionalData(normalized));
    return {
      ...normalized,
      enc: Buffer.from(sender.enc).toString("base64"),
      ciphertext: Buffer.from(ciphertext).toString("base64"),
    };
  } catch (cause) {
    throw new SealedResultError("ENCRYPTION_FAILED", "Unable to encrypt sealed result.", { cause });
  }
}

export function sealedResultCommitment(envelope) {
  const normalized = validateSealedResult(envelope);
  return `0x${createHash("sha256").update(`${DOMAIN}/commitment|${JSON.stringify(normalized)}`).digest("hex")}`;
}

export async function openSealedResult({ sealedResult, recipientPrivateKey, expectedOrderDigest }) {
  validateOrderDigest(expectedOrderDigest);
  const envelope = validateSealedResult(sealedResult);
  if (envelope.orderDigest !== expectedOrderDigest) {
    fail("ORDER_DIGEST_MISMATCH", "Sealed result does not belong to the expected order.");
  }
  const privateKey = await deserializeRecipientPrivateKey(recipientPrivateKey);
  try {
    const recipient = await suite.createRecipientContext({
      recipientKey: privateKey,
      enc: decodeBase64(envelope.enc, "enc", { length: 32 }),
      info,
    });
    return new Uint8Array(await recipient.open(
      decodeBase64(envelope.ciphertext, "ciphertext", { minimum: 16 }),
      additionalData(envelope),
    ));
  } catch (cause) {
    throw new SealedResultError("DECRYPTION_FAILED", "Sealed result authentication or decryption failed.", { cause });
  }
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const PAYMENT_GATED_VERSION = 1;
export const PAYMENT_GATED_SUITE = "AES-256-GCM";
const DOMAIN = "ProofOrder/PaymentGatedDisclosure/v1";
const ENVELOPE_FIELDS = ["version", "suite", "orderDigest", "iv", "ciphertext", "tag", "keyCommitment"];
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// This experiment cannot enforce payment, delay key release, or make a provider
// release the key. Encryption and integrity alone do not establish fair exchange.
export class PaymentGatedError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "PaymentGatedError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PaymentGatedError(code, message);
}

function exactFields(value, fields, { optional = [], code = "INVALID_ENVELOPE" } = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(code, "Value must be a plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((field) => !fields.includes(field) && !optional.includes(field)) || fields.some((field) => {
    const descriptor = descriptors[field];
    return !descriptor || !Object.hasOwn(descriptor, "value");
  }) || keys.some((field) => !Object.hasOwn(descriptors[field], "value"))) {
    fail(code, "Object fields do not match the expected schema.");
  }
  return Object.fromEntries([...fields, ...optional].filter((field) => descriptors[field])
    .map((field) => [field, descriptors[field].value]));
}

function validateOrderDigest(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    fail("INVALID_ORDER_DIGEST", "Order digest must be a canonical lowercase 32-byte hex string.");
  }
  return value;
}

function decodeBase64(value, field, { length } = {}) {
  if (typeof value !== "string" || !BASE64_RE.test(value)) {
    fail("INVALID_BASE64", `${field} must be canonical padded base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) fail("INVALID_BASE64", `${field} must be canonical padded base64.`);
  if (length !== undefined && decoded.length !== length) {
    fail("INVALID_LENGTH", `${field} has an invalid byte length.`);
  }
  return decoded;
}

function validateCommitment(value, field) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    fail("INVALID_COMMITMENT", `${field} must be a canonical lowercase 32-byte hex string.`);
  }
  return value;
}

function keyCommitment(orderDigest, key) {
  return `0x${createHash("sha256").update(`${DOMAIN}/key|${orderDigest}|`).update(key).digest("hex")}`;
}

function aad(envelope) {
  return Buffer.from(`${DOMAIN}/aad|${JSON.stringify({
    version: envelope.version,
    suite: envelope.suite,
    orderDigest: envelope.orderDigest,
    keyCommitment: envelope.keyCommitment,
  })}`);
}

export function validatePaymentGatedEnvelope(value) {
  const envelope = exactFields(value, ENVELOPE_FIELDS);
  if (envelope.version !== PAYMENT_GATED_VERSION || envelope.suite !== PAYMENT_GATED_SUITE) {
    fail("UNSUPPORTED_SUITE", "Unsupported payment-gated envelope version or suite.");
  }
  validateOrderDigest(envelope.orderDigest);
  decodeBase64(envelope.iv, "iv", { length: 12 });
  decodeBase64(envelope.ciphertext, "ciphertext");
  decodeBase64(envelope.tag, "tag", { length: 16 });
  validateCommitment(envelope.keyCommitment, "keyCommitment");
  return envelope;
}

export function paymentGatedCommitment(value) {
  const envelope = validatePaymentGatedEnvelope(value);
  const normalized = Object.fromEntries(ENVELOPE_FIELDS.map((field) => [field, envelope[field]]));
  return `0x${createHash("sha256").update(`${DOMAIN}/envelope|${JSON.stringify(normalized)}`).digest("hex")}`;
}

export function createPaymentGatedEnvelope(input) {
  const { plaintext, orderDigest } = exactFields(input, ["plaintext", "orderDigest"], { code: "INVALID_ARGUMENTS" });
  if (!(plaintext instanceof Uint8Array)) fail("INVALID_PLAINTEXT", "Plaintext must be a Uint8Array.");
  validateOrderDigest(orderDigest);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const envelope = {
    version: PAYMENT_GATED_VERSION,
    suite: PAYMENT_GATED_SUITE,
    orderDigest,
    iv: iv.toString("base64"),
    ciphertext: "",
    tag: "",
    keyCommitment: keyCommitment(orderDigest, key),
  };
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(envelope));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  envelope.ciphertext = ciphertext.toString("base64");
  envelope.tag = cipher.getAuthTag().toString("base64");
  return { envelope, providerSecret: { releasedKey: key.toString("base64") } };
}

export function openPaymentGatedResult(options) {
  const { envelope: input, releasedKey, expectedOrderDigest, expectedEnvelopeCommitment } = exactFields(options,
    ["envelope", "expectedOrderDigest", "expectedEnvelopeCommitment"], {
      optional: ["releasedKey"], code: "INVALID_ARGUMENTS",
    });
  const envelope = validatePaymentGatedEnvelope(input);
  const digest = validateOrderDigest(expectedOrderDigest);
  const pinnedCommitment = validateCommitment(expectedEnvelopeCommitment, "expectedEnvelopeCommitment");
  if (envelope.orderDigest !== digest) fail("ORDER_DIGEST_MISMATCH", "Envelope does not belong to the expected order.");
  if (paymentGatedCommitment(envelope) !== pinnedCommitment) {
    fail("ENVELOPE_COMMITMENT_MISMATCH", "Envelope does not match the externally pinned commitment.");
  }
  if (releasedKey === undefined || releasedKey === null) fail("KEY_UNAVAILABLE", "The provider has not released the data key.");
  const key = decodeBase64(releasedKey, "releasedKey", { length: 32 });
  const committedKey = Buffer.from(envelope.keyCommitment.slice(2), "hex");
  const actualKey = Buffer.from(keyCommitment(digest, key).slice(2), "hex");
  if (!timingSafeEqual(committedKey, actualKey)) fail("KEY_COMMITMENT_MISMATCH", "Released key does not match the committed key.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, decodeBase64(envelope.iv, "iv", { length: 12 }));
    decipher.setAAD(aad(envelope));
    decipher.setAuthTag(decodeBase64(envelope.tag, "tag", { length: 16 }));
    return new Uint8Array(Buffer.concat([decipher.update(decodeBase64(envelope.ciphertext, "ciphertext")), decipher.final()]));
  } catch (cause) {
    throw new PaymentGatedError("DECRYPTION_FAILED", "Payment-gated ciphertext authentication failed.", { cause });
  }
}

import { randomBytes, webcrypto } from "node:crypto";
import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

const { subtle } = webcrypto;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

const constants = Object.freeze({
  version: 1,
  chainId: 31337,
  taskType: "constrained-allocation-v1",
  ruleId: "allocation-score-v1",
  verifierVersion: "g0-binding-experiment-v1",
  paymentAsset: "TEST",
  feeMinorUnits: 100,
  deadlineSeconds: 900,
});

function asBytes(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function hex(value) {
  return Buffer.from(asBytes(value)).toString("hex");
}

async function sha256(value) {
  return new Uint8Array(await subtle.digest("SHA-256", asBytes(value)));
}

function canonicalOrder(nonce = 1) {
  return {
    ...constants,
    nonce,
    buyer: "0xbuyer",
    provider: "0xprovider",
    payee: "0xprovider",
    inputCommitment: "sha256:fixed-snapshot-001",
  };
}

async function orderDigest(order) {
  return sha256(encoder.encode(`ProofOrder/v1|${JSON.stringify(order)}`));
}

async function encryptResult(result, recipientPublicKey, digest) {
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = new Uint8Array(await subtle.exportKey("raw", key));
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: digest },
    key,
    encoder.encode(JSON.stringify(result)),
  ));
  const sender = await suite.createSenderContext({ recipientPublicKey });
  const wrappedKey = new Uint8Array(await sender.seal(rawKey, digest));
  return { enc: asBytes(sender.enc), iv: asBytes(iv), ciphertext, wrappedKey };
}

async function decryptResult(sealed, recipientPrivateKey, digest) {
  const recipient = await suite.createRecipientContext({ recipientKey: recipientPrivateKey, enc: sealed.enc });
  const rawKey = new Uint8Array(await recipient.open(sealed.wrappedKey, digest));
  const key = await subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: sealed.iv, additionalData: digest },
    key,
    sealed.ciphertext,
  );
  return JSON.parse(decoder.decode(plaintext));
}

function cloneSealed(sealed) {
  return Object.fromEntries(Object.entries(sealed).map(([key, value]) => [key, asBytes(value).slice()]));
}

async function mustReject(label, operation) {
  try {
    await operation();
  } catch {
    return `${label}=rejected`;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

const recipient = await suite.kem.generateKeyPair();
const result = Object.freeze({
  taskType: constants.taskType,
  allocations: [{ target: "target-a", amountMinorUnits: 4000, scoreBps: 8125 }],
  unallocatedMinorUnits: 0,
});

let successfulRounds = 0;
for (let nonce = 1; nonce <= 20; nonce += 1) {
  const digest = await orderDigest(canonicalOrder(nonce));
  const sealed = await encryptResult(result, recipient.publicKey, digest);
  const recovered = await decryptResult(sealed, recipient.privateKey, digest);
  if (JSON.stringify(recovered) !== JSON.stringify(result)) throw new Error(`round ${nonce} recovery mismatch`);
  successfulRounds += 1;
}

const order = canonicalOrder(999);
const digest = await orderDigest(order);
const sealed = await encryptResult(result, recipient.publicKey, digest);
const tamperedCiphertext = cloneSealed(sealed);
tamperedCiphertext.ciphertext[0] ^= 1;
const tamperedDigest = await orderDigest({ ...order, payee: "0xattacker" });
const tamperedWrappedKey = cloneSealed(sealed);
tamperedWrappedKey.wrappedKey[0] ^= 1;

const rejectionResults = [
  await mustReject("ciphertext", () => decryptResult(tamperedCiphertext, recipient.privateKey, digest)),
  await mustReject("order-aad", () => decryptResult(sealed, recipient.privateKey, tamperedDigest)),
  await mustReject("wrapped-key", () => decryptResult(tamperedWrappedKey, recipient.privateKey, digest)),
];

console.log(JSON.stringify({
  experiment: "g0-hpke-binding",
  suite: "DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM",
  rounds: successfulRounds,
  orderDigest: `sha256:${hex(digest)}`,
  ciphertextCommitment: `sha256:${hex(await sha256(sealed.ciphertext))}`,
  rejectionResults,
  assumptions: [
    "buyer private key remains secret",
    "ciphertext and wrapped key remain retrievable",
    "HPKE and WebCrypto implementations are used as shipped and are not an audit",
  ],
}, null, 2));

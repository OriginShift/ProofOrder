import { createHash, webcrypto } from "node:crypto";
import { getAddress } from "ethers";

const encoder = new TextEncoder();

export const ORDER_DOMAIN = "ProofOrder/OrderSpec/v1";

export const ORDER_CONSTANTS = Object.freeze({
  version: 1,
  chainId: 31337,
  settlementContract: "0x0000000000000000000000000000000000000001",
  taskType: "constrained-allocation-v1",
  ruleId: "allocation-score-v1",
  verifierVersion: "g0-binding-experiment-v1",
  paymentAsset: "TEST",
  feeMinorUnits: 100,
  deadlineSeconds: 900,
});

const ORDER_FIELDS = [
  "version", "nonce", "chainId", "settlementContract", "buyer", "provider", "payee",
  "taskType", "ruleId", "verifierVersion", "paymentAsset", "feeMinorUnits", "deadlineSeconds",
  "deadline", "snapshot", "inputCommitment", "recipientPublicKey", "verifierAddress",
];
const HASH = /^sha256:[0-9a-f]{64}$/;
const HEX_HASH = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function hasExactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === fields.length
    && fields.every((field) => descriptors[field] && Object.hasOwn(descriptors[field], "value"));
}

function isNonzeroAddress(value) {
  try {
    return getAddress(value) !== ZERO_ADDRESS;
  } catch {
    return false;
  }
}

function isValidId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function isValidOrderSnapshot(snapshot) {
  if (!hasExactFields(snapshot, ["id", "targets"]) || !isValidId(snapshot.id)
    || !Array.isArray(snapshot.targets) || snapshot.targets.length === 0 || snapshot.targets.length > 1024) return false;
  const ids = new Set();
  for (const target of snapshot.targets) {
    if (!hasExactFields(target, ["id", "liquidityBps", "scoreBps"]) || !isValidId(target.id) || ids.has(target.id)) return false;
    if (![target.liquidityBps, target.scoreBps].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000)) return false;
    ids.add(target.id);
  }
  return true;
}

export function isValidOrderSpec(order) {
  if ((!hasExactFields(order, ORDER_FIELDS) && !hasExactFields(order, [...ORDER_FIELDS, "orderId"]))
    || (Object.hasOwn(order, "orderId") && !HEX_HASH.test(order.orderId))
    || order.version !== 1 || !HEX_HASH.test(order.nonce)
    || !Number.isSafeInteger(order.chainId) || order.chainId <= 0
    || ![order.settlementContract, order.buyer, order.provider, order.payee, order.verifierAddress].every(isNonzeroAddress)
    || order.taskType !== ORDER_CONSTANTS.taskType || order.ruleId !== ORDER_CONSTANTS.ruleId
    || order.verifierVersion !== "ecdsa-evaluator-v1" || order.paymentAsset !== "native"
    || typeof order.feeMinorUnits !== "string" || !/^[1-9][0-9]{0,77}$/.test(order.feeMinorUnits)
    || BigInt(order.feeMinorUnits) >= 2n ** 256n
    || !Number.isSafeInteger(order.deadlineSeconds) || order.deadlineSeconds <= 0
    || !Number.isSafeInteger(order.deadline) || order.deadline <= 0
    || order.deadlineSeconds > order.deadline
    || !isValidOrderSnapshot(order.snapshot) || !HASH.test(order.inputCommitment)
    || order.inputCommitment !== snapshotCommitment(order.snapshot)) return false;
  return typeof order.recipientPublicKey === "string";
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalOrder(order) {
  const normalized = canonicalize({ ...ORDER_CONSTANTS, ...order });
  return JSON.stringify(normalized);
}

export function snapshotCommitment(snapshot) {
  return `sha256:${createHash("sha256").update(`ProofOrder/InputSnapshot/v1|${JSON.stringify(canonicalize(snapshot))}`).digest("hex")}`;
}

export async function orderDigest(order) {
  const data = encoder.encode(`${ORDER_DOMAIN}|${canonicalOrder(order)}`);
  const digest = await webcrypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

export function hex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

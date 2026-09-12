import { createHash, webcrypto } from "node:crypto";

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

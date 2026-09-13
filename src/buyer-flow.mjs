// Buyer-side workflow (Qy-owned slice): freeze the order, durably checkpoint it before any
// settlement or release action, verify the provider submission against that checkpoint instead of
// against provider-supplied data, and only then decide whether settlement or refund is legal.
//
// Trust boundary: the checkpoint is the buyer's own record. A bundle that arrives with its own
// "trusted context" is not an independent anchor, so every check here compares against the
// checkpoint, never against values carried by the bundle.
import { isDeepStrictEqual } from "node:util";
import { verifyEncryptedRecoveryBundle } from "./recovery.mjs";
import { orderDigest, orderIdFromDigest } from "./order.mjs";
import { verifyFrozenOrderSpec } from "./order-spec.mjs";
import { nextSettlementAction } from "./settlement-status.mjs";

export const BUYER_CHECKPOINT_SCHEMA = 1;

const CHECKPOINT_FIELDS = [
  "schemaVersion", "orderId", "order", "orderDigest", "chainId", "contractAddress",
  "verifierAddress", "checkpointedAt", "trust",
];
const FORBIDDEN_FIELDS = [
  "recipientPrivateKey", "privateKey", "walletPrivateKey", "mnemonic", "secretKey", "buyerPrivateKey",
];

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function reject(code, message, retryable, extra = {}) {
  return { ok: false, code, message, retryable, ...extra };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

/// Creates the buyer checkpoint. Returns a plain JSON object so the caller can persist it with
/// `saveRecoveryBundle` before funding or settling anything.
export async function createBuyerCheckpoint({ order, orderId, createdAt, ...rest }) {
  for (const field of Object.keys(rest)) {
    if (FORBIDDEN_FIELDS.includes(field)) {
      return reject("PRIVATE_KEY_REFUSED", `a buyer checkpoint must never carry ${field}`, false, { field });
    }
  }
  const verified = verifyFrozenOrderSpec(order);
  if (!verified.ok) {
    return reject("INVALID_ORDER", `order rejected by the frozen specification: ${verified.code}/${verified.field ?? "-"}`, false, { cause: verified });
  }
  const digest = `sha256:${Buffer.from(await orderDigest(verified.order)).toString("hex")}`;
  const derivedOrderId = orderIdFromDigest(digest);
  if (orderId !== undefined && orderId !== derivedOrderId) {
    return reject("ORDER_ID_MISMATCH", "the supplied order id does not match the frozen order digest", false);
  }
  const checkpoint = {
    schemaVersion: BUYER_CHECKPOINT_SCHEMA,
    orderId: derivedOrderId,
    order: verified.order,
    orderDigest: digest,
    chainId: verified.order.chainId,
    contractAddress: verified.order.settlementContract,
    verifierAddress: verified.order.verifierAddress,
    checkpointedAt: createdAt ?? new Date().toISOString(),
    trust: {
      expectedOrderId: derivedOrderId,
      expectedOrderDigest: digest,
      expectedChainId: verified.order.chainId,
      expectedContractAddress: verified.order.settlementContract,
      expectedVerifierAddress: verified.order.verifierAddress,
    },
  };
  const selfCheck = await verifyBuyerCheckpoint(checkpoint);
  if (!selfCheck.ok) {
    return reject("INVALID_CHECKPOINT", `checkpoint failed its own verification: ${selfCheck.code}`, false);
  }
  return { ok: true, checkpoint };
}

/// Re-derives every binding from the checkpointed order and rejects anything inconsistent.
export async function verifyBuyerCheckpoint(checkpoint) {
  if (!plainObject(checkpoint)) {
    return reject("INVALID_CHECKPOINT", "a buyer checkpoint must be a plain object", true);
  }
  for (const field of Object.keys(checkpoint).sort()) {
    if (!CHECKPOINT_FIELDS.includes(field)) {
      return reject("UNKNOWN_FIELD", `${field} is not part of the buyer checkpoint schema`, true, { field });
    }
  }
  if (checkpoint.schemaVersion !== BUYER_CHECKPOINT_SCHEMA) {
    return reject("INVALID_CHECKPOINT", `unsupported checkpoint schema ${String(checkpoint.schemaVersion)}`, true);
  }
  for (const field of CHECKPOINT_FIELDS) {
    if (!Object.hasOwn(checkpoint, field)) {
      return reject("INVALID_CHECKPOINT", `${field} is missing from the checkpoint`, true, { field });
    }
  }
  if (!plainObject(checkpoint.trust) || !plainObject(checkpoint.order)) {
    return reject("INVALID_CHECKPOINT", "checkpoint order and trust must be plain objects", true);
  }
  const frozen = verifyFrozenOrderSpec(checkpoint.order);
  if (!frozen.ok) {
    return reject("INVALID_ORDER", `checkpointed order no longer matches the frozen specification: ${frozen.code}`, false, { cause: frozen });
  }
  const digest = `sha256:${Buffer.from(await orderDigest(frozen.order)).toString("hex")}`;
  if (checkpoint.orderDigest !== digest) {
    return reject("ORDER_DIGEST_MISMATCH", "checkpointed order digest does not match the order bytes", false);
  }
  if (checkpoint.orderId !== orderIdFromDigest(digest)) {
    return reject("ORDER_ID_MISMATCH", "checkpointed order id is not derived from the order digest", false);
  }
  if (checkpoint.chainId !== frozen.order.chainId) {
    return reject("CHAIN_MISMATCH", "checkpoint chain id differs from the order", false);
  }
  if (String(checkpoint.contractAddress).toLowerCase() !== String(frozen.order.settlementContract).toLowerCase()) {
    return reject("CONTRACT_MISMATCH", "checkpoint contract address differs from the order", false);
  }
  if (String(checkpoint.verifierAddress).toLowerCase() !== String(frozen.order.verifierAddress).toLowerCase()) {
    return reject("VERIFIER_MISMATCH", "checkpoint verifier address differs from the order", false);
  }
  const expectedTrust = {
    expectedOrderId: checkpoint.orderId,
    expectedOrderDigest: checkpoint.orderDigest,
    expectedChainId: checkpoint.chainId,
    expectedContractAddress: checkpoint.contractAddress,
    expectedVerifierAddress: checkpoint.verifierAddress,
  };
  if (!isDeepStrictEqual(checkpoint.trust, expectedTrust)) {
    return reject("INVALID_CHECKPOINT", "checkpoint trust block does not match its own bindings", false);
  }
  return { ok: true, checkpoint, orderDigest: checkpoint.orderDigest, trust: expectedTrust };
}

/// Verifies a provider submission against the buyer's own checkpoint. No network access: the
/// caller supplies the chain context separately through `settlement-status`.
export async function verifyProviderSubmission({ checkpoint, bundle }) {
  const anchor = await verifyBuyerCheckpoint(checkpoint);
  if (!anchor.ok) {
    const callerFixable = ["INVALID_CHECKPOINT", "UNKNOWN_FIELD", "MISSING_FIELD"].includes(anchor.code);
    return {
      ok: false,
      code: anchor.code === "INVALID_CHECKPOINT" ? "INVALID_TRUST" : anchor.code,
      message: anchor.message,
      retryable: callerFixable,
      decision: "supply-checkpoint",
      cause: anchor.code,
    };
  }
  if (!plainObject(bundle)) {
    return { ok: false, code: "INVALID_BUNDLE", message: "provider submission must be a bundle object", retryable: false, decision: "reject-submission" };
  }
  if (JSON.stringify(canonical(bundle.order)) !== JSON.stringify(canonical(anchor.checkpoint.order))) {
    return { ok: false, code: "ORDER_MISMATCH", message: "bundle carries a different order than the checkpoint", retryable: false, decision: "reject-submission" };
  }
  const verification = await verifyEncryptedRecoveryBundle(bundle, anchor.trust);
  if (!verification.ok) {
    return {
      ok: false,
      code: verification.code,
      message: `provider submission rejected: ${verification.code}`,
      retryable: verification.code === "INVALID_TRUST",
      decision: "reject-submission",
    };
  }
  return {
    ok: true,
    code: "VERIFIED",
    retryable: false,
    decision: "accept-and-checkpoint",
    orderId: anchor.checkpoint.orderId,
    orderDigest: anchor.checkpoint.orderDigest,
    ciphertextCommitment: verification.ciphertextCommitment,
    evidenceDigest: verification.evidenceDigest,
    verifierAddress: verification.verifierAddress,
    verification,
  };
}

/// The settlement/release gate: a durable checkpoint plus a verified submission plus a chain state
/// whose next legal action is settle/refund/complete. Anything else is refused with a stable code.
export function requireSettlementAllowed({ checkpoint, verification, chainStatus }) {
  if (checkpoint === undefined || checkpoint === null) {
    return reject("MISSING_CHECKPOINT", "no durable buyer checkpoint was supplied; settlement stays blocked", true);
  }
  if (!verification || verification.ok !== true) {
    return reject(
      "SUBMISSION_NOT_VERIFIED",
      "the provider submission is not verified against the buyer checkpoint",
      Boolean(verification?.retryable),
      { cause: verification?.code ?? "INVALID_BUNDLE" },
    );
  }
  if (!chainStatus || chainStatus.ok !== true) {
    return reject(
      chainStatus?.code ?? "RPC_UNAVAILABLE",
      chainStatus?.message ?? "chain state could not be read",
      chainStatus?.retryable ?? true,
    );
  }
  const next = nextSettlementAction(chainStatus);
  if (!["settle", "refund", "complete"].includes(next.action)) {
    return reject("CHAIN_NOT_READY", `chain state ${chainStatus.stateName} does not allow release: ${next.reason}`, true, {
      nextAction: next.action,
    });
  }
  return { ok: true, action: next.action, actor: next.actor, retryable: true, reason: next.reason, chainStatus };
}

export { CHECKPOINT_FIELDS };

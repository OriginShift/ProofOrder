// Frozen G0 order specification (Qy-owned slice).
//
// This module owns the "freeze the task constants and the canonical OrderSpec encoding"
// requirement: callers may supply order parameters, but the rule binding, asset, version and
// task type are constants of the frozen specification. Every rejection carries a stable code
// plus a `retryable` flag so a caller can distinguish "fix the input" from "this mechanism
// refuses the requested change".
import { createHash } from "node:crypto";
import { ALLOCATION_RULES } from "./evaluator.mjs";
import { ORDER_CONSTANTS, isValidOrderSnapshot, isValidOrderSpec, snapshotCommitment } from "./order.mjs";

const HEX_HASH = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Fields required in every frozen OrderSpec, in canonical encoding order.
export const FROZEN_ORDER_FIELDS = Object.freeze([
  "version", "nonce", "chainId", "settlementContract", "buyer", "provider", "payee",
  "taskType", "ruleId", "verifierVersion", "paymentAsset", "feeMinorUnits", "deadlineSeconds",
  "deadline", "snapshot", "inputCommitment", "recipientPublicKey", "verifierAddress",
]);

// Derived fields a caller may attach after freezing (they are never used as rule inputs).
export const FROZEN_ORDER_OPTIONAL_FIELDS = Object.freeze(["orderId"]);

// Values that a caller may not override while using this frozen specification version.
export const FROZEN_ORDER_CONSTANTS = Object.freeze({
  version: ORDER_CONSTANTS.version,
  taskType: ORDER_CONSTANTS.taskType,
  ruleId: ORDER_CONSTANTS.ruleId,
  verifierVersion: "ecdsa-evaluator-v1",
  paymentAsset: "native",
});

export const FROZEN_ORDER_DEFAULTS = Object.freeze({
  feeMinorUnits: ORDER_CONSTANTS.feeMinorUnits.toString(),
  deadlineSeconds: ORDER_CONSTANTS.deadlineSeconds,
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function describe() {
  return {
    domain: "ProofOrder/FrozenOrderSpec/v1",
    fields: [...FROZEN_ORDER_FIELDS],
    optionalFields: [...FROZEN_ORDER_OPTIONAL_FIELDS],
    constants: { ...FROZEN_ORDER_CONSTANTS },
    defaults: { ...FROZEN_ORDER_DEFAULTS },
    allocationRules: { ...ALLOCATION_RULES },
    orderDomain: "ProofOrder/OrderSpec/v1",
    verifierId: "local-verifier",
    proofSystem: "deterministic-evaluator-evidence-v1",
  };
}

function deepFreeze(value) {
  for (const entry of Object.values(value)) {
    if (entry && typeof entry === "object") deepFreeze(entry);
  }
  return Object.freeze(value);
}

export const FROZEN_ORDER_SPEC = deepFreeze(describe());

export const FROZEN_ORDER_SPEC_DIGEST = `sha256:${createHash("sha256")
  .update(JSON.stringify(describeFrozenOrderSpec()))
  .digest("hex")}`;

/// Returns a mutable plain-JSON copy for evidence reports.
export function describeFrozenOrderSpec() {
  return describe();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function isNonzeroAddress(value) {
  try {
    return typeof value === "string" && value.toLowerCase() !== ZERO_ADDRESS
      && /^0x[0-9a-fA-F]{40}$/.test(value);
  } catch {
    return false;
  }
}

function isFrozenConstant(field, value) {
  return Object.hasOwn(FROZEN_ORDER_CONSTANTS, field) && value !== FROZEN_ORDER_CONSTANTS[field];
}

function validFee(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < 2n ** 256n;
}

const STRING_RULES = {
  version: (value) => value === FROZEN_ORDER_CONSTANTS.version,
  nonce: (value) => typeof value === "string" && HEX_HASH.test(value),
  chainId: (value) => Number.isSafeInteger(value) && value > 0,
  settlementContract: isNonzeroAddress,
  buyer: isNonzeroAddress,
  provider: isNonzeroAddress,
  payee: isNonzeroAddress,
  taskType: (value) => value === FROZEN_ORDER_CONSTANTS.taskType,
  ruleId: (value) => value === FROZEN_ORDER_CONSTANTS.ruleId,
  verifierVersion: (value) => value === FROZEN_ORDER_CONSTANTS.verifierVersion,
  paymentAsset: (value) => value === FROZEN_ORDER_CONSTANTS.paymentAsset,
  feeMinorUnits: validFee,
  deadlineSeconds: (value) => Number.isSafeInteger(value) && value > 0,
  recipientPublicKey: (value) => typeof value === "string" && value.length > 0,
  verifierAddress: isNonzeroAddress,
  orderId: (value) => typeof value === "string" && HEX_HASH.test(value),
};

const SNAPSHOT_FIELDS = new Set(["snapshot", "inputCommitment"]);

function reject(code, field, message, retryable) {
  const rejection = { ok: false, code, message, retryable };
  if (field !== undefined) rejection.field = field;
  return rejection;
}

function fieldError(field, order) {
  if (field === "deadline") {
    if (!Number.isSafeInteger(order.deadline) || order.deadline <= 0) return "deadline must be a positive safe integer";
    return "deadline must not be shorter than the declared deadlineSeconds window";
  }
  if (SNAPSHOT_FIELDS.has(field)) {
    return "snapshot must match the frozen allocation-input schema";
  }
  return `${field} does not match the frozen order specification`;
}

function validateFrozen(order) {
  for (const field of FROZEN_ORDER_FIELDS) {
    if (isFrozenConstant(field, order[field])) {
      return reject("FROZEN_CONSTANT", field, `${field} is a frozen constant of this specification version`, false);
    }
  }
  for (const field of FROZEN_ORDER_FIELDS) {
    if (field === "deadline" || SNAPSHOT_FIELDS.has(field)) continue;
    if (!STRING_RULES[field](order[field])) return reject("INVALID_FIELD", field, fieldError(field, order), true);
  }
  if (!Number.isSafeInteger(order.deadline) || order.deadline <= 0 || order.deadline < order.deadlineSeconds) {
    return reject("INVALID_FIELD", "deadline", fieldError("deadline", order), true);
  }
  if (!isValidOrderSnapshot(order.snapshot)) {
    return reject("INVALID_FIELD", "snapshot", fieldError("snapshot", order), true);
  }
  const derived = snapshotCommitment(order.snapshot);
  if (order.inputCommitment !== derived) {
    return reject("SNAPSHOT_MISMATCH", "inputCommitment", "inputCommitment is not the commitment of the supplied snapshot", true);
  }
  if (Object.hasOwn(order, "orderId") && !STRING_RULES.orderId(order.orderId)) {
    return reject("INVALID_FIELD", "orderId", fieldError("orderId", order), true);
  }
  if (!isValidOrderSpec(order)) {
    return reject("INVALID_ORDER", undefined, "order does not match the frozen order specification", false);
  }
  return { ok: true, order };
}

/// Fills the frozen constants/defaults, derives the input commitment and validates the result.
export function freezeOrderSpec(draft) {
  if (!isPlainObject(draft)) {
    return reject("NOT_AN_OBJECT", undefined, "an order draft must be a plain object", true);
  }
  const allowed = new Set([...FROZEN_ORDER_FIELDS, ...FROZEN_ORDER_OPTIONAL_FIELDS]);
  for (const field of Object.keys(draft).sort()) {
    if (!allowed.has(field)) return reject("UNKNOWN_FIELD", field, `${field} is not part of the frozen order specification`, true);
  }
  for (const field of FROZEN_ORDER_FIELDS) {
    if (Object.hasOwn(FROZEN_ORDER_DEFAULTS, field) || Object.hasOwn(FROZEN_ORDER_CONSTANTS, field)
      || SNAPSHOT_FIELDS.has(field)) continue;
    if (!Object.hasOwn(draft, field)) return reject("MISSING_FIELD", field, `${field} is required`, true);
  }
  if (!Object.hasOwn(draft, "snapshot")) return reject("MISSING_FIELD", "snapshot", "snapshot is required", true);
  for (const field of Object.keys(FROZEN_ORDER_CONSTANTS)) {
    if (Object.hasOwn(draft, field) && isFrozenConstant(field, draft[field])) {
      return reject("FROZEN_CONSTANT", field, `${field} is a frozen constant of this specification version`, false);
    }
  }
  if (Object.hasOwn(draft, "inputCommitment") && !isValidOrderSnapshot(draft.snapshot)) {
    return reject("INVALID_FIELD", "snapshot", fieldError("snapshot", draft), true);
  }

  const order = {};
  for (const field of FROZEN_ORDER_FIELDS) {
    if (field === "inputCommitment") continue;
    if (Object.hasOwn(draft, field)) order[field] = draft[field];
    else if (Object.hasOwn(FROZEN_ORDER_DEFAULTS, field)) order[field] = FROZEN_ORDER_DEFAULTS[field];
    else order[field] = FROZEN_ORDER_CONSTANTS[field];
  }
  const derived = isValidOrderSnapshot(order.snapshot) ? snapshotCommitment(order.snapshot) : undefined;
  if (Object.hasOwn(draft, "inputCommitment") && derived !== undefined && draft.inputCommitment !== derived) {
    return reject("SNAPSHOT_MISMATCH", "inputCommitment", "inputCommitment is not the commitment of the supplied snapshot", true);
  }
  order.inputCommitment = derived;
  if (Object.hasOwn(draft, "orderId")) order.orderId = draft.orderId;

  const validated = validateFrozen(order);
  if (!validated.ok) return validated;
  return { ok: true, order: validated.order };
}

/// Strict check of a complete order against the frozen specification; never fills defaults.
export function verifyFrozenOrderSpec(order) {
  if (!isPlainObject(order)) {
    return reject("NOT_AN_OBJECT", undefined, "a frozen order must be a plain object", true);
  }
  const allowed = new Set([...FROZEN_ORDER_FIELDS, ...FROZEN_ORDER_OPTIONAL_FIELDS]);
  for (const field of Object.keys(order).sort()) {
    if (!allowed.has(field)) return reject("UNKNOWN_FIELD", field, `${field} is not part of the frozen order specification`, true);
  }
  for (const field of FROZEN_ORDER_FIELDS) {
    if (!Object.hasOwn(order, field)) return reject("MISSING_FIELD", field, `${field} is required`, true);
  }
  const validated = validateFrozen(order);
  if (!validated.ok) return validated;
  return { ok: true, order: validated.order };
}

/// Deep-frozen copy of an order for callers that persist a checkpoint.
export function sealFrozenOrder(order) {
  return deepFreeze(canonicalize(structuredClone(order)));
}

// Verifier-side independent verification of a submitted delivery.
//
// The recorded adapter authorizes on chain an ECDSA attestation, so the attestation is only worth
// something if the signer re-derived it. This module therefore refuses to accept the provider's
// claimed evaluation: it authenticates and opens the committed ciphertext,
// reruns the frozen rule over the recovered allocations, recomputes the evidence, compares the
// result with the provider claim and with the on-chain `Submitted` binding, and only then reports
// that an attestation is safe to sign.
//
// Trust disclosure: in this local demo the verifier is handed the recipient private key, so it can
// decrypt. That is a trusted-verifier property, not private isolation, and every successful result
// says so explicitly.
import { isDeepStrictEqual } from "node:util";
import { buildEvidence } from "./evidence.mjs";
import { evaluateAllocation } from "./evaluator.mjs";
import { hex, orderDigest as digestOrder, orderIdFromDigest } from "./order.mjs";
import { verifyFrozenOrderSpec } from "./order-spec.mjs";
import { openSealedResult, sealedResultCommitment, validateSealedResult } from "./sealed-result.mjs";

const HASH = /^sha256:[0-9a-f]{64}$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;

export const SUBMISSION_FIELDS = Object.freeze([
  "schemaVersion", "orderId", "orderDigest", "ciphertextCommitment", "sealedResult", "evidence", "submittedAt",
]);

export const VERIFICATION_PATHS = Object.freeze({
  DECRYPT: "independent-decrypt-and-reevaluate",
});

const DISCLOSURES = Object.freeze({
  [VERIFICATION_PATHS.DECRYPT]: Object.freeze({
    verifierDecryptionCapability: true,
    plaintextSource: "the verifier opened the committed ciphertext with the supplied recipient key",
    trustBoundary:
      "In this trusted local demo the verifier holds decryption capability, so this is not private isolation: anyone with the recipient key can also decrypt. What the independent path does prove is that the verifier re-derived the evidence instead of signing the provider claim.",
  }),
});

export function verificationDisclosure(path) {
  return DISCLOSURES[path] ?? null;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactFields(value, fields) {
  if (!plainObject(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === fields.length
    && fields.every((field) => descriptors[field] && Object.hasOwn(descriptors[field], "value"));
}

function address(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

function fail(code, message, retryable, extra = {}) {
  return { ok: false, code, message, retryable, ...extra };
}

/// The persisted submission carries the `0x…` bytes32 form; the recovery bundle carries `sha256:…`.
/// They are the same 32 bytes, so the verifier accepts either canonical encoding and compares the
/// normalized value.
function normalizeCommitment(value) {
  if (typeof value !== "string") return null;
  if (/^0x[0-9a-f]{64}$/.test(value)) return value;
  if (HASH.test(value)) return `0x${value.slice(7)}`;
  return null;
}

function validAllocations(allocations) {
  return Array.isArray(allocations) && allocations.length > 0
    && allocations.every((allocation) => exactFields(allocation, ["target", "amountMinorUnits"])
      && typeof allocation.target === "string" && allocation.target.length > 0
      && Number.isSafeInteger(allocation.amountMinorUnits) && allocation.amountMinorUnits > 0);
}

/// Independently verifies one persisted provider submission.
///
/// `recipientPrivateKey` (HPKE demo key) is required. Plaintext-only inputs are rejected
/// because they cannot prove the contents of the ciphertext. `chainStatus` is a status read from
/// `readSettlementStatus`; `requireChainBinding` defaults to true and no caller in this repository
/// turns it off.
export async function verifySubmittedDelivery({
  order: suppliedOrder,
  orderId: expectedOrderId,
  orderDigest: expectedOrderDigest,
  submission,
  recipientPrivateKey,
  plaintextResult,
  chainStatus,
  requireChainBinding = true,
} = {}) {
  const frozen = verifyFrozenOrderSpec(suppliedOrder);
  if (!frozen.ok) {
    return fail("INVALID_ORDER", `order rejected by the frozen specification: ${frozen.code}/${frozen.field ?? "-"}`, false, { cause: frozen });
  }
  const order = frozen.order;
  const digest = `sha256:${hex(await digestOrder(order))}`;
  const derivedOrderId = orderIdFromDigest(digest);

  if (expectedOrderDigest !== undefined && expectedOrderDigest !== digest) {
    return fail("ORDER_DIGEST_MISMATCH", "the supplied order digest is not the digest of the supplied order bytes", false);
  }
  if (expectedOrderId !== undefined && expectedOrderId !== derivedOrderId) {
    return fail("ORDER_ID_MISMATCH", "the supplied order id is not derived from the order digest", false);
  }

  if (!exactFields(submission, SUBMISSION_FIELDS)) {
    return fail("INVALID_SUBMISSION", "the submission is not a persisted provider submission", true);
  }
  if (submission.orderId !== derivedOrderId) {
    return fail("ORDER_ID_MISMATCH", "the submission is bound to a different order id than the frozen order", false);
  }
  if (submission.orderDigest !== digest) {
    return fail("ORDER_DIGEST_MISMATCH", "the submission is bound to a different order digest than the frozen order", false);
  }
  const submittedCommitment = normalizeCommitment(submission.ciphertextCommitment);
  if (submittedCommitment === null) {
    return fail("INVALID_SUBMISSION", "the submission has no canonical ciphertext commitment", true);
  }

  let envelope;
  try {
    envelope = validateSealedResult(submission.sealedResult);
  } catch {
    return fail("INVALID_SEALED_RESULT", "the sealed result envelope is not readable", false);
  }
  if (envelope.orderDigest !== `0x${digest.slice(7)}`) {
    return fail("ORDER_DIGEST_MISMATCH", "the sealed result binds a different order digest", false);
  }
  if (envelope.recipientPublicKey !== order.recipientPublicKey) {
    return fail("RECIPIENT_MISMATCH", "the sealed result is addressed to a different recipient key", false);
  }
  const commitment = sealedResultCommitment(envelope);
  const commitmentDigest = `sha256:${commitment.slice(2)}`;
  if (submittedCommitment !== commitment) {
    return fail("CIPHERTEXT_COMMITMENT_MISMATCH", "the stored commitment is not the commitment of the sealed result bytes", false);
  }

  // The verifier's own input. Without it there is nothing independent to evaluate.
  let allocations;
  let verificationPath;
  if (typeof recipientPrivateKey === "string" && recipientPrivateKey.length > 0) {
    verificationPath = VERIFICATION_PATHS.DECRYPT;
    let plaintext;
    try {
      plaintext = await openSealedResult({
        sealedResult: submission.sealedResult,
        recipientPrivateKey,
        expectedOrderDigest: `0x${digest.slice(7)}`,
      });
    } catch {
      return fail("DECRYPTION_FAILED", "the verifier could not authenticate and open the committed ciphertext", false);
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    } catch {
      return fail("INVALID_PLAINTEXT", "the opened plaintext is not valid UTF-8 JSON", false);
    }
    if (!exactFields(parsed, ["allocations"])) {
      return fail("INVALID_PLAINTEXT", "the opened plaintext does not match the frozen result schema", false);
    }
    allocations = parsed.allocations;
  } else if (plaintextResult !== undefined) {
    return fail("UNBOUND_PLAINTEXT_REFUSED", "A separately supplied plaintext has no cryptographic binding to this ciphertext. Supply the recipient verification key to authenticate and decrypt the committed bytes.", false);
  } else {
    return fail(
      "MISSING_VERIFICATION_INPUT",
      "the verifier needs a recipient key to authenticate the committed ciphertext; it will not sign the provider's claim",
      true,
    );
  }
  if (!validAllocations(allocations)) {
    return fail("INVALID_PLAINTEXT", "the recovered allocations do not match the frozen result schema", false);
  }

  const evaluation = evaluateAllocation({ snapshot: order.snapshot, allocations });
  if (!evaluation.ok) {
    return fail("RESULT_EVALUATION_FAILED", `the recovered result fails the frozen rule: ${evaluation.code}`, false, { evaluation });
  }
  const expectedEvidence = buildEvidence({
    orderDigest: digest,
    ciphertextCommitment: commitmentDigest,
    evaluation,
  });

  if (!exactFields(submission.evidence, ["proofSystem", "verifierId", "publicInputs", "evaluation", "evidenceDigest"])) {
    return fail("INVALID_EVIDENCE", "the provider evidence does not match the evidence schema", false);
  }
  if (!isDeepStrictEqual(submission.evidence.evaluation, evaluation)) {
    return fail("EVALUATION_MISMATCH", "the provider's claimed evaluation is not the evaluation of the committed result", false, {
      claimed: submission.evidence.evaluation,
      rederived: evaluation,
    });
  }
  if (!isDeepStrictEqual(submission.evidence, expectedEvidence)) {
    return fail("EVIDENCE_MISMATCH", "the provider evidence is not the evidence of the committed ciphertext and recovered result", false);
  }

  let chain = null;
  if (requireChainBinding) {
    if (!chainStatus || chainStatus.ok !== true) {
      return fail(
        chainStatus?.code ?? "RPC_UNAVAILABLE",
        chainStatus?.message ?? "the on-chain order state could not be read",
        chainStatus?.retryable ?? true,
      );
    }
    if (chainStatus.orderId !== derivedOrderId) {
      return fail("CHAIN_ORDER_MISMATCH", "the chain read is for a different order id", false);
    }
    if (!chainStatus.verification?.submitted) {
      return fail("NOT_SUBMITTED", "the funded order carries no on-chain Submitted binding to attest", true);
    }
    if (chainStatus.state !== 2 && chainStatus.state !== 3) {
      return fail("CHAIN_NOT_READY", `chain state ${chainStatus.stateName} cannot be attested`, false);
    }
    if (String(chainStatus.verification.ciphertextCommitment).toLowerCase() !== commitment.toLowerCase()) {
      return fail("CHAIN_CIPHERTEXT_MISMATCH", "the on-chain Submitted commitment is not the ciphertext the verifier opened", false);
    }
    const funding = chainStatus.funding ?? {};
    const termsMatch = address(funding.buyer) === address(order.buyer)
      && address(funding.provider) === address(order.provider)
      && address(funding.payee) === address(order.payee)
      && BigInt(funding.amountWei ?? "0") === BigInt(order.feeMinorUnits)
      && Number(funding.deadline) === Number(order.deadline);
    if (!termsMatch) {
      return fail("CHAIN_ORDER_MISMATCH", "the funded on-chain order terms differ from the frozen order", false);
    }
    if (chainStatus.state === 3) {
      const recorded = String(chainStatus.verification.evidenceDigest).toLowerCase();
      if (recorded !== ZERO_HASH && recorded !== `0x${expectedEvidence.evidenceDigest.slice(7)}`) {
        return fail("CHAIN_EVIDENCE_MISMATCH", "the chain already records a different verified evidence digest", false);
      }
    }
    chain = {
      state: chainStatus.state,
      stateName: chainStatus.stateName,
      ciphertextCommitment: chainStatus.verification.ciphertextCommitment,
      alreadyVerified: chainStatus.state === 3,
    };
  }

  return {
    ok: true,
    code: "INDEPENDENTLY_VERIFIED",
    retryable: false,
    orderId: derivedOrderId,
    orderDigest: digest,
    ciphertextCommitment: commitment,
    ciphertextDigest: commitmentDigest,
    evidenceDigest: expectedEvidence.evidenceDigest,
    evaluation,
    verificationPath,
    chain,
    disclosure: DISCLOSURES[verificationPath],
    deliveryObserved: false,
    deliveryNote:
      "Re-deriving the evidence proves the frozen rule holds for the committed bytes. The chain cannot observe that the buyer decrypted them, so this is not delivery.",
  };
}

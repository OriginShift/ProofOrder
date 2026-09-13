import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAddress, getBytes, solidityPackedKeccak256, verifyMessage } from "ethers";
import { buildEvidence } from "./evidence.mjs";
import { ALLOCATION_RULES, evaluateAllocation } from "./evaluator.mjs";
import { isValidOrderSpec, orderDigest as digestOrder } from "./order.mjs";
import { openSealedResult, sealedResultCommitment, validateSealedResult } from "./sealed-result.mjs";

function commitment(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function createRecoveryBundle({ order, orderDigest, ciphertext, evidence, chainId, contractAddress, retrieval }) {
  const bytes = Buffer.from(ciphertext);
  return {
    schemaVersion: 1,
    order,
    orderDigest,
    ciphertext: bytes.toString("base64"),
    ciphertextCommitment: commitment(bytes),
    evidence,
    chain: { chainId, contractAddress },
    retrieval,
  };
}

export function verifyRecoveryBundle(bundle) {
  if (!bundle || bundle.schemaVersion !== 1 || !bundle.ciphertext || !bundle.orderDigest || !bundle.evidence) {
    return { ok: false, code: "INVALID_BUNDLE" };
  }
  const actual = commitment(Buffer.from(bundle.ciphertext, "base64"));
  if (actual !== bundle.ciphertextCommitment) return { ok: false, code: "CIPHERTEXT_COMMITMENT_MISMATCH" };
  if (bundle.evidence.publicInputs?.orderDigest && bundle.evidence.publicInputs.orderDigest !== bundle.orderDigest) {
    return { ok: false, code: "ORDER_DIGEST_MISMATCH" };
  }
  if (bundle.evidence.publicInputs?.ciphertextCommitment && bundle.evidence.publicInputs.ciphertextCommitment !== bundle.ciphertextCommitment) {
    return { ok: false, code: "EVIDENCE_COMMITMENT_MISMATCH" };
  }
  return { ok: true, ciphertext: Buffer.from(bundle.ciphertext, "base64") };
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const HEX_HASH = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BUNDLE_FIELDS = [
  "schemaVersion", "orderId", "order", "orderDigest", "sealedResult", "ciphertextCommitment",
  "evidence", "attestation", "chain",
];

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === fields.length
    && fields.every((field) => descriptors[field] && Object.hasOwn(descriptors[field], "value"));
}

function address(value) {
  try {
    const normalized = getAddress(value);
    return normalized === ZERO_ADDRESS ? null : normalized;
  } catch {
    return null;
  }
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validTrust(trust) {
  return trust && typeof trust === "object"
    && HEX_HASH.test(trust.expectedOrderId) && trust.expectedOrderId !== `0x${"0".repeat(64)}`
    && HASH.test(trust.expectedOrderDigest)
    && Number.isSafeInteger(trust.expectedChainId) && trust.expectedChainId > 0
    && address(trust.expectedContractAddress) && address(trust.expectedVerifierAddress);
}

function validEvaluation(evaluation) {
  return exactFields(evaluation, ["ok", "totalMinorUnits", "scoreBps", "ruleVersion"])
    && evaluation.ok === true && evaluation.totalMinorUnits === ALLOCATION_RULES.budgetMinorUnits
    && Number.isSafeInteger(evaluation.scoreBps) && evaluation.scoreBps >= ALLOCATION_RULES.minScoreBps
    && evaluation.scoreBps <= 10_000 && evaluation.ruleVersion === "allocation-score-v1";
}

function fail(code) {
  return { ok: false, code };
}

export async function createEncryptedRecoveryBundle({ orderId, order, sealedResult, evidence, signature, verifierAddress }) {
  const bundle = structuredClone({
    schemaVersion: 2,
    orderId,
    order,
    sealedResult,
    evidence,
    attestation: { signature, verifierAddress },
    chain: { chainId: order.chainId, contractAddress: order.settlementContract },
  });
  bundle.orderDigest = `sha256:${Buffer.from(await digestOrder(bundle.order)).toString("hex")}`;
  bundle.ciphertextCommitment = `sha256:${sealedResultCommitment(bundle.sealedResult).slice(2)}`;
  const verification = await verifyEncryptedRecoveryBundle(bundle, {
    expectedOrderId: orderId,
    expectedOrderDigest: bundle.orderDigest,
    expectedChainId: bundle.order.chainId,
    expectedContractAddress: bundle.order.settlementContract,
    expectedVerifierAddress: verifierAddress,
  });
  if (!verification.ok) {
    throw Object.assign(new Error(`Invalid encrypted recovery bundle: ${verification.code}`), { code: verification.code });
  }
  return bundle;
}

export async function verifyEncryptedRecoveryBundle(bundle, trust) {
  try {
    if (!validTrust(trust)) return fail("INVALID_TRUST");
    if (!exactFields(bundle, BUNDLE_FIELDS) || bundle.schemaVersion !== 2) return fail("INVALID_BUNDLE");
    bundle = structuredClone(bundle);
    trust = structuredClone(trust);
    if (!isValidOrderSpec(bundle.order)) return fail("INVALID_ORDER");
    if (bundle.orderId !== trust.expectedOrderId) return fail("ORDER_ID_MISMATCH");
    if (Object.hasOwn(bundle.order, "orderId") && bundle.order.orderId !== trust.expectedOrderId) return fail("ORDER_ID_MISMATCH");
    if (bundle.orderDigest !== trust.expectedOrderDigest) return fail("ORDER_DIGEST_MISMATCH");
    const actualOrderDigest = `sha256:${Buffer.from(await digestOrder(bundle.order)).toString("hex")}`;
    if (actualOrderDigest !== bundle.orderDigest) return fail("ORDER_DIGEST_MISMATCH");
    if (!exactFields(bundle.chain, ["chainId", "contractAddress"])
      || bundle.chain.chainId !== trust.expectedChainId || bundle.order.chainId !== trust.expectedChainId
      || address(bundle.chain.contractAddress) !== address(trust.expectedContractAddress)
      || address(bundle.order.settlementContract) !== address(trust.expectedContractAddress)) return fail("CHAIN_MISMATCH");
    if (!exactFields(bundle.attestation, ["signature", "verifierAddress"])
      || address(bundle.attestation.verifierAddress) !== address(trust.expectedVerifierAddress)
      || address(bundle.order.verifierAddress) !== address(trust.expectedVerifierAddress)) return fail("VERIFIER_MISMATCH");

    let envelope;
    try {
      envelope = validateSealedResult(bundle.sealedResult);
    } catch {
      return fail("INVALID_SEALED_RESULT");
    }
    const digestHex = `0x${bundle.orderDigest.slice(7)}`;
    if (envelope.orderDigest !== digestHex) return fail("ENVELOPE_ORDER_MISMATCH");
    if (envelope.recipientPublicKey !== bundle.order.recipientPublicKey) return fail("RECIPIENT_MISMATCH");
    const envelopeCommitment = sealedResultCommitment(envelope);
    if (bundle.ciphertextCommitment !== `sha256:${envelopeCommitment.slice(2)}`) return fail("CIPHERTEXT_COMMITMENT_MISMATCH");
    if (!exactFields(bundle.evidence, ["proofSystem", "verifierId", "publicInputs", "evaluation", "evidenceDigest"])
      || !validEvaluation(bundle.evidence.evaluation)) return fail("INVALID_EVIDENCE");
    const expectedEvidence = buildEvidence({
      orderDigest: bundle.orderDigest,
      ciphertextCommitment: bundle.ciphertextCommitment,
      evaluation: bundle.evidence.evaluation,
    });
    if (!isDeepStrictEqual(bundle.evidence, expectedEvidence)) return fail("EVIDENCE_MISMATCH");
    if (typeof bundle.attestation.signature !== "string" || !/^0x[0-9a-fA-F]{128}(?:1b|1c)$/i.test(bundle.attestation.signature)) return fail("INVALID_SIGNATURE");
    const messageHash = solidityPackedKeccak256(
      ["string", "uint256", "address", "bytes32", "bytes32", "bytes32", "bytes32"],
      ["ProofOrder/VerificationEvidence/v1", trust.expectedChainId, trust.expectedContractAddress, bundle.orderId,
        digestHex, envelopeCommitment, `0x${expectedEvidence.evidenceDigest.slice(7)}`],
    );
    let recoveredVerifier;
    try {
      recoveredVerifier = verifyMessage(getBytes(messageHash), bundle.attestation.signature);
    } catch {
      return fail("INVALID_SIGNATURE");
    }
    if (address(recoveredVerifier) !== address(trust.expectedVerifierAddress)) return fail("INVALID_SIGNATURE");
    return { ok: true, orderDigest: bundle.orderDigest, ciphertextCommitment: bundle.ciphertextCommitment, evidenceDigest: expectedEvidence.evidenceDigest, verifierAddress: recoveredVerifier };
  } catch {
    return fail("INVALID_BUNDLE");
  }
}

export async function recoverEncryptedResult(bundle, options) {
  try {
    bundle = structuredClone(bundle);
    options = structuredClone(options);
  } catch {
    return fail("INVALID_BUNDLE");
  }
  const verification = await verifyEncryptedRecoveryBundle(bundle, options);
  if (!verification.ok) return verification;
  let plaintext;
  try {
    plaintext = await openSealedResult({
      sealedResult: bundle.sealedResult,
      recipientPrivateKey: options.recipientPrivateKey,
      expectedOrderDigest: `0x${bundle.orderDigest.slice(7)}`,
    });
  } catch {
    return fail("DECRYPTION_FAILED");
  }
  let result;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    return fail("INVALID_PLAINTEXT");
  }
  if (!exactFields(result, ["allocations"]) || !Array.isArray(result.allocations)
    || result.allocations.length === 0 || result.allocations.length > bundle.order.snapshot.targets.length
    || !result.allocations.every((allocation) => exactFields(allocation, ["target", "amountMinorUnits"])
      && validId(allocation.target) && Number.isSafeInteger(allocation.amountMinorUnits) && allocation.amountMinorUnits > 0)) {
    return fail("INVALID_PLAINTEXT");
  }
  // Only the input snapshot committed by the signed order can supply target metadata.
  const evaluation = evaluateAllocation({ snapshot: bundle.order.snapshot, allocations: result.allocations });
  if (!evaluation.ok) return fail("RESULT_EVALUATION_FAILED");
  if (!isDeepStrictEqual(evaluation, bundle.evidence.evaluation)) return fail("EVALUATION_MISMATCH");
  return { ...verification, result, evaluation };
}

export async function saveRecoveryBundle(path, bundle) {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const parent = await open(directory, "r");
    try {
      try {
        await parent.sync();
      } catch (error) {
        // Windows does not expose directory handles that Node can flush with fsync. The file
        // itself was synced before the atomic rename; tolerate only this unsupported directory
        // flush while preserving other I/O failures.
        if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
      }
    } finally {
      await parent.close();
    }
  } finally {
    if (file) await file.close();
    await rm(temporary, { force: true });
  }
}

export async function loadRecoveryBundle(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

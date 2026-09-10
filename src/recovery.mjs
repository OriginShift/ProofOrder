import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

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

export async function saveRecoveryBundle(path, bundle) {
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}

export async function loadRecoveryBundle(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

import { createHash } from "node:crypto";

const encoder = new TextEncoder();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function evidenceDigest({ orderDigest, ciphertextCommitment, evaluation }) {
  const payload = canonical({
    domain: "ProofOrder/VerificationEvidence/v1",
    orderDigest,
    ciphertextCommitment,
    evaluation,
  });
  return `sha256:${sha256(encoder.encode(JSON.stringify(payload)))}`;
}

export function buildEvidence({ orderDigest, ciphertextCommitment, evaluation }) {
  return {
    proofSystem: "signed-deterministic-evaluator-v1",
    verifierId: "local-verifier",
    publicInputs: { orderDigest, ciphertextCommitment },
    evaluation,
    evidenceDigest: evidenceDigest({ orderDigest, ciphertextCommitment, evaluation }),
  };
}

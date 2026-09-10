import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidence } from "../src/evidence.mjs";

const base = {
  orderDigest: "sha256:order",
  ciphertextCommitment: "sha256:ciphertext",
  evaluation: { ok: true, scoreBps: 7960, totalMinorUnits: 10000, ruleVersion: "allocation-score-v1" },
};

test("evidence digest binds order, ciphertext, and evaluation", () => {
  const evidence = buildEvidence(base);
  assert.equal(evidence.proofSystem, "signed-deterministic-evaluator-v1");
  assert.match(evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(buildEvidence({ ...base, ciphertextCommitment: "sha256:other" }).evidenceDigest, evidence.evidenceDigest);
  assert.notEqual(buildEvidence({ ...base, evaluation: { ...base.evaluation, scoreBps: 7499 } }).evidenceDigest, evidence.evidenceDigest);
});

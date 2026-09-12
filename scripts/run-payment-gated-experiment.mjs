import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createPaymentGatedEnvelope, openPaymentGatedResult, publicPaymentGatedEnvelope, releasePaymentKey } from "../src/payment-gated-experiment.mjs";

const orderDigest = `0x${"ab".repeat(32)}`;
const plaintext = Buffer.from(JSON.stringify({ allocations: [{ target: "target-a", amountMinorUnits: 6000 }] }));
const envelope = createPaymentGatedEnvelope({ plaintext, orderDigest });
const publicBundle = publicPaymentGatedEnvelope(envelope);
let prepaymentError;
try {
  openPaymentGatedResult({ envelope: publicBundle, expectedOrderDigest: orderDigest });
} catch (error) {
  prepaymentError = error.code;
}
assert.equal(prepaymentError, "KEY_UNAVAILABLE");
const releasedKey = releasePaymentKey(envelope);
assert.deepEqual(Buffer.from(openPaymentGatedResult({ envelope, releasedKey, expectedOrderDigest: orderDigest })), plaintext);
const withholdingError = (() => {
  try {
    openPaymentGatedResult({ envelope: publicBundle, expectedOrderDigest: orderDigest });
    return null;
  } catch (error) {
    return error.code;
  }
})();
assert.equal(withholdingError, "KEY_UNAVAILABLE");
const report = {
  experiment: "payment-gated-disclosure-v1",
  status: "candidate-fails-fair-exchange",
  orderDigest,
  ciphertextCommitment: publicBundle.ciphertextCommitment,
  keyCommitment: publicBundle.keyCommitment,
  prepaymentDecryptable: false,
  prepaymentError,
  postSettlementReleaseDecryptable: true,
  providerWithholdingAfterSettlement: true,
  withholdingError,
  plaintextSha256: createHash("sha256").update(plaintext).digest("hex"),
  claimBoundary: "The candidate prevents local decryption until a key release, but payment does not force the provider to release that key. It is an experiment, not a production fair-exchange protocol.",
};
await mkdir(new URL("../evidence/runs/", import.meta.url), { recursive: true });
await writeFile(new URL("../evidence/runs/0015-payment-gated-disclosure.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

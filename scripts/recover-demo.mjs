import { loadRecoveryBundle, recoverEncryptedResult } from "../src/recovery.mjs";

try {
  const [bundlePath, keyPath, contextPath, ...extra] = process.argv.slice(2);
  if (!bundlePath || !keyPath || !contextPath || extra.length) {
    throw new Error("Usage: node scripts/recover-demo.mjs <bundle.json> <buyer-key.json> <trusted-context.json>");
  }
  const bundle = await loadRecoveryBundle(bundlePath);
  const key = await loadRecoveryBundle(keyPath);
  const expected = await loadRecoveryBundle(contextPath);
  const recovered = await recoverEncryptedResult(bundle, { ...expected, recipientPrivateKey: key.recipientPrivateKey });
  if (!recovered.ok) throw new Error(`Recovery rejected: ${recovered.code}`);
  console.log(JSON.stringify({
    ok: true, result: recovered.result, evaluation: recovered.evaluation,
    settlementStatus: "not-queried", claimBoundary: "Offline recovery and trusted-verifier attestation only; payment is not inferred from a bundle.",
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

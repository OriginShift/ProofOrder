// Trusted-verifier CLI: independently re-evaluate a submitted delivery, then sign the deterministic
// evidence for it. It never signs the provider's claim.
//
//   verifier-cli attest --rpc URL --dir DIR [--verifier-index 2]
//                       --verification-key-file FILE   (recipient HPKE secret; verifier decrypts)
//                       [--submission-file FILE]
//
// Passing the recipient key means the verifier can decrypt the committed ciphertext. That is a
// trusted-local-demo property and every success reports it as a disclosure, not as private
// isolation. A separately supplied plaintext is not an alternate success path: it is not bound to
// the committed ciphertext and is rejected. The signature is produced only after decrypting the
// committed bytes, re-running the frozen rule, recomputing the evidence, and confirming the on-chain
// `Submitted` binding.
import { getBytes } from "ethers";
import { connectLocal, createReceiptRecorder, loadSettlementArtifact, settlementAt } from "../src/chain-client.mjs";
import { integerFlag, parseArgs, readJson, recordStep, requiredFlag, runCli, workflowPaths, writeJson } from "../src/cli.mjs";
import { createEncryptedRecoveryBundle } from "../src/recovery.mjs";
import { verifyFrozenOrderSpec } from "../src/order-spec.mjs";
import { readSettlementStatus } from "../src/settlement-status.mjs";
import { verifySubmittedDelivery } from "../src/verifier-flow.mjs";

const COMMANDS = ["attest"];

function refuse(code, message, retryable = false, extra = {}) {
  return { ok: false, step: "attest", code, message, retryable, ...extra };
}

async function loadVerifierInput(flags, paths) {
  const keyFile = flags["verification-key-file"];
  const resultFile = flags["verification-result-file"];
  if (keyFile !== undefined && resultFile !== undefined && keyFile !== true && resultFile !== true) {
    throw Object.assign(new Error("supply only --verification-key-file; a plaintext result cannot verify the committed ciphertext"), { code: "USAGE" });
  }
  if (typeof keyFile === "string") {
    const file = await readJson(keyFile, "verification key file");
    if (typeof file?.recipientPrivateKey !== "string" || file.recipientPrivateKey.length === 0) {
      throw Object.assign(new Error("verification key file has no recipientPrivateKey"), { code: "USAGE", field: "recipientPrivateKey" });
    }
    return { recipientPrivateKey: file.recipientPrivateKey, inputSource: keyFile };
  }
  if (typeof resultFile === "string") {
    const file = await readJson(resultFile, "verification result file");
    return { plaintextResult: { allocations: file?.allocations }, inputSource: resultFile };
  }
  throw Object.assign(
    new Error("a recipient key is required to verify the committed ciphertext: --verification-key-file FILE"),
    { code: "MISSING_VERIFICATION_INPUT", retryable: true, dir: paths.directory },
  );
}

async function attest(flags) {
  const rpc = requiredFlag(flags, "rpc");
  const paths = workflowPaths(requiredFlag(flags, "dir"));
  const orderFile = await readJson(paths.order, "order.json");
  const frozen = verifyFrozenOrderSpec(orderFile.order);
  if (!frozen.ok) {
    return refuse("INVALID_ORDER", `order.json rejected: ${frozen.code}/${frozen.field ?? "-"}`);
  }
  const order = frozen.order;
  const submissionFile = typeof flags["submission-file"] === "string" ? flags["submission-file"] : paths.submission;
  const submission = await readJson(submissionFile, "provider-submission.json");
  const input = await loadVerifierInput(flags, paths);

  const { provider } = await connectLocal(rpc);
  const signer = await provider.getSigner(integerFlag(flags, "verifier-index", 2));
  const verifierAddress = await signer.getAddress();
  if (verifierAddress.toLowerCase() !== order.verifierAddress.toLowerCase()) {
    return refuse("VERIFIER_NOT_AUTHORIZED", `signer ${verifierAddress} is not the order verifier ${order.verifierAddress}`, false, { verifierAddress });
  }

  const artifact = await loadSettlementArtifact();
  const readContract = settlementAt({ address: order.settlementContract, abi: artifact.abi, runner: provider });
  const chainStatus = await readSettlementStatus({
    contract: readContract,
    orderId: orderFile.orderId,
    expected: {
      expectedOrderId: orderFile.orderId,
      // The chain stores the order digest as bytes32; the checkpoint/recovery form is "sha256:".
      expectedOrderDigest: `0x${String(orderFile.orderDigest).slice(-64)}`,
      expectedChainId: order.chainId,
      expectedContractAddress: order.settlementContract,
      expectedVerifierAddress: order.verifierAddress,
    },
  });

  const verification = await verifySubmittedDelivery({
    order,
    orderId: orderFile.orderId,
    orderDigest: orderFile.orderDigest,
    submission,
    chainStatus,
    ...input,
  });
  if (!verification.ok) {
    return refuse(verification.code, verification.message, verification.retryable, {
      verificationPath: null,
      chainState: chainStatus.ok === true ? chainStatus.stateName : (chainStatus.code ?? "unreadable"),
    });
  }

  const digestHex = `0x${verification.orderDigest.slice(7)}`;
  const evidenceDigestHex = `0x${verification.evidenceDigest.slice(7)}`;
  const contract = settlementAt({ address: order.settlementContract, abi: artifact.abi, runner: signer });
  const message = await contract.evidenceMessageHash(
    orderFile.orderId, digestHex, verification.ciphertextCommitment, evidenceDigestHex,
  );
  const signature = await signer.signMessage(getBytes(message));
  const bundle = await createEncryptedRecoveryBundle({
    orderId: orderFile.orderId,
    order,
    sealedResult: submission.sealedResult,
    evidence: submission.evidence,
    signature,
    verifierAddress,
  });
  const bundleFile = await writeJson(paths.bundle, bundle);

  // The attestation only changes the settlement state once it is published. `markVerified` is
  // permissionless; publishing our own attestation is the least surprising default (use
  // --no-publish to stop after signing).
  let published = null;
  if (flags["no-publish"] !== true) {
    const { mined, transactions } = createReceiptRecorder();
    const receipt = await mined(
      contract.markVerified(orderFile.orderId, digestHex, verification.ciphertextCommitment, evidenceDigestHex, signature),
      "markVerified",
    );
    published = { transactionHash: receipt.hash, blockNumber: receipt.blockNumber, transactions };
  }
  await recordStep(paths.workflow, {
    step: "attest", orderId: orderFile.orderId, verifierAddress, evidenceDigest: verification.evidenceDigest,
    messageHash: message, signatureLength: signature.length,
    verificationPath: verification.verificationPath, chainState: verification.chain.stateName,
    inputSource: input.inputSource, published: published !== null,
    attestationTransactionHash: published?.transactionHash ?? null,
  });

  return {
    ok: true, step: "attest", orderId: orderFile.orderId, verifierAddress, bundleFile,
    orderDigest: verification.orderDigest, ciphertextCommitment: verification.ciphertextCommitment,
    evidenceDigest: verification.evidenceDigest, evaluation: verification.evaluation, messageHash: message,
    verificationPath: verification.verificationPath,
    independentlyReEvaluated: true,
    chainState: verification.chain.stateName,
    chainStateAfterAttest: published ? "Verified" : verification.chain.stateName,
    publishedOnChain: published !== null,
    attestationTransactionHash: published?.transactionHash ?? null,
    attestationTransactions: published?.transactions ?? [],
    alreadyVerifiedOnChain: verification.chain.alreadyVerified,
    deliveryObserved: false,
    attestationKind: "trusted-ecdsa-attestation",
    disclosure: verification.disclosure,
    note: "The signature authenticates an evaluation the verifier re-derived from the committed ciphertext and re-ran against the frozen rule. It is not a zero-knowledge proof, it does not attest delivery, and it does not solve fair exchange.",
  };
}

const handlers = { attest };

const { command, flags } = (() => {
  try {
    return parseArgs(process.argv.slice(2), COMMANDS);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, step: "usage", code: error.code, message: error.message, commands: COMMANDS }));
    process.exit(2);
  }
})();

await runCli(command, () => handlers[command](flags));

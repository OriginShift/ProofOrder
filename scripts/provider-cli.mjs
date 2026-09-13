// Independent provider CLI: evaluate the frozen rule, seal the result, persist the submission and
// commit its ciphertext binding on chain. It never sees the buyer's checkpoint or private key.
//
// Ordering matters for safety: the provider re-derives the order id/digest from the order bytes,
// reads the on-chain order and compares every funded term *before* it writes a submission file or
// sends a transaction. Sealing is deterministic per call but the HPKE encapsulation is randomised,
// so a repeated submit can never reproduce the first ciphertext: when the order is already
// committed on chain the CLI compares the chain against the *persisted* delivery and either reports
// an idempotent no-op or refuses, instead of overwriting a delivered ciphertext with a new one.
//
//   provider-cli submit --rpc URL --dir DIR [--provider-index 1] [--allocations-file FILE]
import { connectLocal, createReceiptRecorder, loadSettlementArtifact, settlementAt } from "../src/chain-client.mjs";
import { fileExists, integerFlag, parseArgs, readJson, recordStep, requiredFlag, runCli, workflowPaths, writeJson } from "../src/cli.mjs";
import { FIXTURE_DISCLOSURE, fixedAllocations } from "../src/fixtures.mjs";
import { hex, orderDigest, orderIdFromDigest } from "../src/order.mjs";
import { verifyFrozenOrderSpec } from "../src/order-spec.mjs";
import { prepareProviderSubmission } from "../src/provider-flow.mjs";
import { readSettlementStatus } from "../src/settlement-status.mjs";

const COMMANDS = ["submit"];
const HASH = /^sha256:[0-9a-f]{64}$/;
const HEX_HASH = /^0x[0-9a-f]{64}$/;

function refuse(code, message, retryable = false, extra = {}) {
  return { ok: false, step: "submit", code, message, retryable, ...extra };
}

/// Accepts the `0x…` and `sha256:…` encodings of the same 32-byte commitment.
function normalizeCommitment(value) {
  if (typeof value !== "string") return null;
  if (HEX_HASH.test(value)) return value.toLowerCase();
  if (HASH.test(value)) return `0x${value.slice(7)}`.toLowerCase();
  return null;
}

async function submit(flags) {
  const rpc = requiredFlag(flags, "rpc");
  const paths = workflowPaths(requiredFlag(flags, "dir"));
  const orderFile = await readJson(paths.order, "order.json");
  const frozen = verifyFrozenOrderSpec(orderFile.order);
  if (!frozen.ok) {
    return refuse("INVALID_ORDER", `order.json rejected: ${frozen.code}/${frozen.field ?? "-"}`, false, { cause: frozen });
  }
  const order = frozen.order;
  if (!HEX_HASH.test(orderFile.orderId ?? "")) {
    return refuse("INVALID_ORDER_FILE", "order.json does not carry a canonical order id");
  }
  if (!HASH.test(orderFile.orderDigest ?? "")) {
    return refuse("INVALID_ORDER_FILE", "order.json does not carry a canonical order digest");
  }

  // Re-derive both bindings from the order bytes instead of trusting the buyer's file.
  const digest = `sha256:${hex(await orderDigest(order))}`;
  const orderId = orderIdFromDigest(digest);
  if (orderFile.orderDigest !== digest) {
    return refuse("ORDER_DIGEST_MISMATCH", "order.json digest is not the digest of its own order bytes");
  }
  if (orderFile.orderId !== orderId) {
    return refuse("ORDER_ID_MISMATCH", "order.json id is not derived from its own order digest");
  }

  const { provider } = await connectLocal(rpc);
  const signer = await provider.getSigner(integerFlag(flags, "provider-index", 1));
  const providerAddress = await signer.getAddress();
  if (providerAddress.toLowerCase() !== order.provider.toLowerCase()) {
    return refuse("PROVIDER_NOT_AUTHORIZED", `signer ${providerAddress} is not the order provider ${order.provider}`);
  }

  const artifact = await loadSettlementArtifact();
  const readContract = settlementAt({ address: order.settlementContract, abi: artifact.abi, runner: provider });
  const chainStatus = await readSettlementStatus({
    contract: readContract,
    orderId,
    expected: {
      expectedOrderId: orderId,
      expectedOrderDigest: `0x${digest.slice(7)}`,
      expectedChainId: order.chainId,
      expectedContractAddress: order.settlementContract,
      expectedVerifierAddress: order.verifierAddress,
    },
  });
  if (!chainStatus.ok) {
    return refuse(chainStatus.code, `${chainStatus.message} (nothing was written and no transaction was sent)`, chainStatus.retryable);
  }
  const funding = chainStatus.funding;
  for (const [field, expectedValue] of [["buyer", order.buyer], ["provider", order.provider], ["payee", order.payee]]) {
    if (String(funding[field]).toLowerCase() !== String(expectedValue).toLowerCase()) {
      return refuse("CHAIN_ORDER_MISMATCH", `the on-chain ${field} is not the frozen order ${field}`);
    }
  }
  if (BigInt(funding.amountWei) !== BigInt(order.feeMinorUnits)) {
    return refuse("CHAIN_ORDER_MISMATCH", "the on-chain escrow amount is not the frozen fee");
  }
  if (Number(funding.deadline) !== Number(order.deadline)) {
    return refuse("CHAIN_ORDER_MISMATCH", "the on-chain deadline is not the frozen deadline");
  }

  const existing = (await fileExists(paths.submission)) ? await readJson(paths.submission, "provider-submission.json") : undefined;
  const committed = normalizeCommitment(chainStatus.verification.ciphertextCommitment);

  // Already committed on chain: never re-seal and never overwrite. The persisted delivery is the
  // only thing that can still match the chain, because the HPKE encapsulation is randomised.
  if (chainStatus.state >= 2 && chainStatus.state <= 4) {
    const persistedCommitment = normalizeCommitment(existing?.ciphertextCommitment);
    if (existing !== undefined && persistedCommitment !== null && persistedCommitment === committed) {
      await recordStep(paths.workflow, {
        step: "submit", repeated: true, orderId, ciphertextCommitment: committed,
        transactionHash: null, note: "already committed on chain; nothing rewritten and no transaction sent",
      });
      return {
        ok: true, step: "submit", repeatedSubmit: true, alreadySubmitted: true, transactionSubmitted: false,
        orderId, orderDigest: digest, ciphertextCommitment: committed,
        evidenceDigest: existing.evidence?.evidenceDigest ?? null, chainState: chainStatus.stateName,
        submissionFile: paths.submission, submissionFileRewritten: false,
        message: "This order is already committed on chain with the same persisted ciphertext; the stored submission was left untouched.",
      };
    }
    return refuse(
      "ALREADY_SUBMITTED",
      existing === undefined
        ? `chain state ${chainStatus.stateName} already carries a submission, but no persisted delivery matches it; refusing to invent or overwrite one`
        : `chain state ${chainStatus.stateName} carries a different ciphertext than the persisted delivery; refusing to overwrite it`,
      false,
      { chainState: chainStatus.stateName, chainCommitment: committed, persistedCommitment },
    );
  }
  if (chainStatus.state !== 1) {
    return refuse("CHAIN_NOT_READY", `chain state ${chainStatus.stateName} does not accept a submission`);
  }

  const allocationsFile = flags["allocations-file"];
  const allocations = allocationsFile === undefined
    ? fixedAllocations()
    : await readJson(String(allocationsFile), "allocations file").then((file) => file.allocations);
  if (!Array.isArray(allocations)) {
    return refuse("INVALID_ALLOCATION_INPUT", "allocations file must contain an allocations array");
  }

  const submission = await prepareProviderSubmission({
    order,
    allocations,
    recipientPublicKey: order.recipientPublicKey,
  });
  if (!submission.ok) {
    return refuse(submission.error.code, submission.error.message, false, { allocationsProvided: allocations.length });
  }
  const sealedOrderDigest = `sha256:${submission.orderDigestHex.slice(2)}`;
  if (sealedOrderDigest !== digest) {
    return refuse("ORDER_DIGEST_MISMATCH", "the sealed result is bound to a different order digest than the frozen order");
  }
  if (existing !== undefined && normalizeCommitment(existing.ciphertextCommitment) !== normalizeCommitment(submission.ciphertextCommitment)) {
    return refuse("SUBMISSION_CONFLICT", "a different submission is already persisted for this order; refusing to overwrite it");
  }

  let persisted = false;
  if (existing === undefined) {
    await writeJson(paths.submission, {
      schemaVersion: 1,
      orderId,
      orderDigest: digest,
      ciphertextCommitment: submission.ciphertextCommitment,
      sealedResult: submission.sealedResult,
      evidence: submission.evidence,
      submittedAt: new Date().toISOString(),
    });
    persisted = true;
  }

  const contract = settlementAt({ address: order.settlementContract, abi: artifact.abi, runner: signer });
  const { mined, transactions } = createReceiptRecorder();
  const receipt = await mined(contract.submit(orderId, submission.ciphertextCommitment), "submit");
  await recordStep(paths.workflow, {
    step: "submit", orderId, ciphertextCommitment: submission.ciphertextCommitment,
    evidenceDigest: submission.evidence.evidenceDigest, transactionHash: receipt.hash, blockNumber: receipt.blockNumber,
  });

  return {
    ok: true, step: "submit", repeatedSubmit: false, transactionSubmitted: true, persisted,
    orderId, orderDigest: digest, providerAddress,
    ciphertextCommitment: submission.ciphertextCommitment,
    evidenceDigest: submission.evidence.evidenceDigest,
    evaluation: submission.evaluation,
    suite: submission.sealedResult.suite,
    chainStateBefore: chainStatus.stateName,
    submissionFile: paths.submission, transactions,
    includesPlaintext: false,
    fixtureDisclosure: FIXTURE_DISCLOSURE,
  };
}

const handlers = { submit };

const { command, flags } = (() => {
  try {
    return parseArgs(process.argv.slice(2), COMMANDS);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, step: "usage", code: error.code, message: error.message, commands: COMMANDS }));
    process.exit(2);
  }
})();

await runCli(command, () => handlers[command](flags));

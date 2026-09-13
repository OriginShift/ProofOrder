// Independent buyer CLI for the frozen ProofOrder workflow.
//
// Run as separate steps so the buyer's durable checkpoint exists before any funding, and so the
// buyer process can pause (or exit) while the provider, verifier and a relayer act:
//
//   buyer-cli init    --rpc URL --dir DIR   freeze the order, deploy settlement, write the checkpoint
//   buyer-cli fund    --rpc URL --dir DIR   fund the frozen order from the buyer signer
//   buyer-cli status  --rpc URL --dir DIR   funding/verification/delivery status plus the next action
//   buyer-cli verify  --dir DIR             offline verification of the provider submission
//   buyer-cli release --rpc URL --dir DIR   settlement, refused unless the gate passes (needs bundle)
//   buyer-cli refund  --rpc URL --dir DIR   timeout refund: checkpoint + chain only, never a bundle
//   buyer-cli recover --dir DIR             offline recovery from the checkpoint, key and bundle
//
// `init` refuses to run over an existing workflow directory: it must never overwrite a key, a
// checkpoint or an order that another step already anchored.
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createBuyerCheckpoint, requireSettlementAllowed, verifyBuyerCheckpoint, verifyProviderSubmission } from "../src/buyer-flow.mjs";
import { createReceiptRecorder, connectLocal, deploySettlement, loadSettlementArtifact, settlementAt } from "../src/chain-client.mjs";
import {
  bigintFlag, fileExists, fileMode, integerFlag, parseArgs, readJson, recordStep, requiredFlag, runCli, workflowPaths, writeJson,
} from "../src/cli.mjs";
import { FIXTURE_DISCLOSURE, fixedSnapshot } from "../src/fixtures.mjs";
import { FROZEN_ORDER_SPEC_DIGEST, freezeOrderSpec, verifyFrozenOrderSpec } from "../src/order-spec.mjs";
import { recoverEncryptedResult } from "../src/recovery.mjs";
import { generateRecipientKeyPair } from "../src/sealed-result.mjs";
import { STATE_NAMES, assertStatusSeparation, nextSettlementAction, readSettlementStatus } from "../src/settlement-status.mjs";

const COMMANDS = ["init", "fund", "status", "verify", "release", "refund", "recover"];

// Every file a started workflow may already own. `init` must not clobber any of them.
const WORKFLOW_STATE_FILES = [
  "order", "checkpoint", "recipientKey", "submission", "bundle", "verifiedSubmission", "workflow", "recovery",
];

function requireRole(signer, expected, code) {
  return signer.getAddress().then((address) => {
    if (address.toLowerCase() !== String(expected).toLowerCase()) {
      throw Object.assign(new Error(`signer ${address} is not ${expected}`), { code });
    }
    return address;
  });
}

async function loadCheckpoint(paths) {
  const checkpoint = await readJson(paths.checkpoint, "checkpoint.json");
  const verified = await verifyBuyerCheckpoint(checkpoint);
  if (!verified.ok) {
    throw Object.assign(new Error(`checkpoint rejected: ${verified.code}`), { code: verified.code });
  }
  return checkpoint;
}

/// The recovery bundle carries `sha256:…` digests while the contract takes bytes32.
function toBytes32(value) {
  return String(value).startsWith("sha256:") ? `0x${String(value).slice(7)}` : String(value);
}

/// The chain stores order digests as bytes32 while the checkpoint/recovery form is "sha256:...".
function chainExpectations(checkpoint) {
  return {
    ...checkpoint.trust,
    expectedOrderDigest: `0x${checkpoint.orderDigest.slice(7)}`,
  };
}

async function chainContext(paths, rpc) {
  const checkpoint = await loadCheckpoint(paths);
  const { provider } = await connectLocal(rpc);
  const artifact = await loadSettlementArtifact();
  const contract = settlementAt({ address: checkpoint.contractAddress, abi: artifact.abi, runner: provider });
  const chainStatus = await readSettlementStatus({ contract, orderId: checkpoint.orderId, expected: chainExpectations(checkpoint) });
  return { checkpoint, provider, artifact, chainStatus };
}

async function assertFreshDirectory(paths) {
  const present = [];
  for (const key of WORKFLOW_STATE_FILES) {
    if (await fileExists(paths[key])) present.push(paths[key]);
  }
  if (present.length > 0) {
    throw Object.assign(
      new Error(`refusing to initialise over an existing workflow: ${present.join(", ")}`),
      { code: "EXISTING_STATE", files: present },
    );
  }
}

async function init(flags) {
  const rpc = requiredFlag(flags, "rpc");
  const directory = requiredFlag(flags, "dir");
  const buyerIndex = integerFlag(flags, "buyer-index", 0);
  const providerIndex = integerFlag(flags, "provider-index", 1);
  const verifierIndex = integerFlag(flags, "verifier-index", 2);
  const deadlineSeconds = integerFlag(flags, "deadline-seconds", 900);
  const amount = bigintFlag(flags, "amount-wei", "1000000000000000000");
  const paths = workflowPaths(directory);
  await mkdir(directory, { recursive: true });
  await assertFreshDirectory(paths);

  const { provider, chainId, clientVersion } = await connectLocal(rpc);
  const buyer = await provider.getSigner(buyerIndex);
  const buyerAddress = await buyer.getAddress();
  const providerAddress = await (await provider.getSigner(providerIndex)).getAddress();
  const verifierAddress = await (await provider.getSigner(verifierIndex)).getAddress();
  const deployed = await deploySettlement({ provider, signer: buyer, verifierAddress });
  const latest = await provider.getBlock("latest");
  const deadline = Number(latest.timestamp) + deadlineSeconds;
  const recipient = await generateRecipientKeyPair();
  const frozen = freezeOrderSpec({
    nonce: `0x${randomBytes(32).toString("hex")}`,
    chainId,
    settlementContract: deployed.address,
    buyer: buyerAddress,
    provider: providerAddress,
    payee: providerAddress,
    feeMinorUnits: amount.toString(),
    deadlineSeconds,
    deadline,
    snapshot: fixedSnapshot(),
    recipientPublicKey: recipient.publicKey,
    verifierAddress,
  });
  if (!frozen.ok) return { ok: false, step: "init", code: frozen.code, field: frozen.field, message: frozen.message };

  const checkpointResult = await createBuyerCheckpoint({ order: frozen.order });
  if (!checkpointResult.ok) return { ok: false, step: "init", ...checkpointResult };
  const { checkpoint } = checkpointResult;

  await writeJson(paths.order, { schemaVersion: 1, orderId: checkpoint.orderId, orderDigest: checkpoint.orderDigest, order: frozen.order });
  await writeJson(paths.checkpoint, checkpoint);
  await writeJson(paths.recipientKey, { schemaVersion: 1, recipientPrivateKey: recipient.privateKey });
  await recordStep(paths.workflow, {
    step: "init", orderId: checkpoint.orderId, orderDigest: checkpoint.orderDigest,
    contractAddress: deployed.address, deployTransactionHash: deployed.transactionHash, checkpointed: true, funded: false,
  });

  return {
    ok: true, step: "init", orderId: checkpoint.orderId, orderDigest: checkpoint.orderDigest,
    contractAddress: deployed.address, chainId, clientVersion, buyerAddress, providerAddress, verifierAddress,
    deadline, deadlineSeconds, amountWei: amount.toString(),
    frozenSpecDigest: FROZEN_ORDER_SPEC_DIGEST,
    files: { order: paths.order, checkpoint: paths.checkpoint, recipientKey: paths.recipientKey, workflow: paths.workflow },
    recipientKeyFileMode: (await fileMode(paths.recipientKey)).toString(8),
    checkpointWrittenBeforeFunding: true,
    deployTransactionHash: deployed.transactionHash,
    fixtureDisclosure: FIXTURE_DISCLOSURE,
  };
}

async function fund(flags) {
  const rpc = requiredFlag(flags, "rpc");
  const paths = workflowPaths(requiredFlag(flags, "dir"));
  const checkpoint = await loadCheckpoint(paths);
  const orderFile = await readJson(paths.order, "order.json");
  const frozen = verifyFrozenOrderSpec(orderFile.order);
  if (!frozen.ok || frozen.order.orderId !== undefined) {
    return { ok: false, step: "fund", code: "INVALID_ORDER", message: "order.json does not carry a frozen order" };
  }
  const amount = bigintFlag(flags, "amount-wei", checkpoint.order.feeMinorUnits);
  if (amount !== BigInt(checkpoint.order.feeMinorUnits)) {
    return { ok: false, step: "fund", code: "AMOUNT_MISMATCH", message: "funding amount differs from the frozen order fee" };
  }

  const { provider } = await connectLocal(rpc);
  const buyer = await provider.getSigner(integerFlag(flags, "buyer-index", 0));
  await requireRole(buyer, checkpoint.order.buyer, "BUYER_NOT_AUTHORIZED");
  const artifact = await loadSettlementArtifact();
  const contract = settlementAt({ address: checkpoint.contractAddress, abi: artifact.abi, runner: buyer });
  const { mined, transactions } = createReceiptRecorder();
  const receipt = await mined(
    contract.fund(checkpoint.orderId, `0x${checkpoint.orderDigest.slice(7)}`, checkpoint.order.provider, checkpoint.order.payee, checkpoint.order.deadline, { value: amount }),
    "fund",
  );
  await recordStep(paths.workflow, { step: "fund", orderId: checkpoint.orderId, transactionHash: receipt.hash, blockNumber: receipt.blockNumber });

  return {
    ok: true, step: "fund", orderId: checkpoint.orderId, amountWei: amount.toString(),
    transactionHash: receipt.hash, blockNumber: receipt.blockNumber, transactions,
  };
}

async function status(flags) {
  const paths = workflowPaths(requiredFlag(flags, "dir"));
  const { checkpoint, chainStatus } = await chainContext(paths, requiredFlag(flags, "rpc"));
  if (!chainStatus.ok) {
    // "No funded order yet" is a legitimate observation, not a failed read: report it as an
    // unfunded status so the caller can act on it. Every other failure stays a failure.
    if (chainStatus.code !== "ORDER_NOT_FOUND") return { ok: false, step: "status", ...chainStatus };
    return {
      ok: true, step: "status", orderId: checkpoint.orderId, state: null, stateIndex: null,
      funding: { funded: false, amountWei: "0", deadline: checkpoint.order.deadline },
      verification: { submitted: false, verified: false },
      delivery: {
        observed: false,
        source: "chain-observes-no-delivery",
        reason: "The settlement contract records a ciphertext commitment and a verifier attestation; it cannot observe that the buyer decrypted a valid result.",
      },
      stateNames: STATE_NAMES,
      separationEnforced: true,
      decision: nextSettlementAction(chainStatus),
      observed: { code: chainStatus.code, message: chainStatus.message },
    };
  }
  const separation = assertStatusSeparation(chainStatus);
  return {
    ok: true, step: "status", orderId: checkpoint.orderId,
    state: chainStatus.stateName, stateIndex: chainStatus.state,
    funding: chainStatus.funding, verification: chainStatus.verification, delivery: chainStatus.delivery,
    stateNames: STATE_NAMES,
    separationEnforced: separation,
    decision: nextSettlementAction(chainStatus),
  };
}

async function verify(flags) {
  const paths = workflowPaths(requiredFlag(flags, "dir"));
  const checkpoint = await loadCheckpoint(paths);
  const bundle = await readJson(paths.bundle, "bundle.json");
  const verification = await verifyProviderSubmission({ checkpoint, bundle });
  if (!verification.ok) return { ok: false, step: "verify", code: verification.code, message: verification.message, retryable: verification.retryable, decision: verification.decision };
  await writeJson(paths.verifiedSubmission, {
    schemaVersion: 1, orderId: checkpoint.orderId, orderDigest: verification.orderDigest,
    ciphertextCommitment: verification.ciphertextCommitment, evidenceDigest: verification.evidenceDigest,
    verifierAddress: verification.verifierAddress, decision: verification.decision,
    verifiedAt: new Date().toISOString(), chainStateQueried: false, deliveryObserved: false,
  });
  return {
    ok: true, step: "verify", decision: verification.decision, orderId: checkpoint.orderId,
    orderDigest: verification.orderDigest, ciphertextCommitment: verification.ciphertextCommitment,
    evidenceDigest: verification.evidenceDigest, verifierAddress: verification.verifierAddress,
    chainStateQueried: false, deliveryObserved: false, verifiedSubmission: paths.verifiedSubmission,
  };
}

async function release(flags) {
  const rpc = requiredFlag(flags, "rpc");
  const paths = workflowPaths(requiredFlag(flags, "dir"));
  const checkpoint = await loadCheckpoint(paths);
  const bundle = await readJson(paths.bundle, "bundle.json");
  const verification = await verifyProviderSubmission({ checkpoint, bundle });
  if (!verification.ok) {
    return { ok: false, step: "release", code: verification.code, message: verification.message, retryable: verification.retryable };
  }
  const { provider, chainStatus } = await chainContext(paths, rpc);
  const gate = requireSettlementAllowed({ checkpoint, verification, chainStatus });
  if (!gate.ok) return { ok: false, step: "release", code: gate.code, message: gate.message, retryable: gate.retryable, nextAction: gate.nextAction, cause: gate.cause };

  if (gate.action === "refund") {
    return {
      ok: false, step: "release", code: "REFUND_REQUIRED", retryable: true, nextAction: "refund",
      message: `${gate.reason} Use the refund command; it needs the durable checkpoint and chain state only, never the provider bundle.`,
      requiredCommand: { command: "refund", flags: ["--rpc", "--dir"] },
    };
  }
  if (gate.action === "complete") {
    return { ok: true, step: "release", action: "complete", orderId: checkpoint.orderId, state: chainStatus.stateName, transactions: [] };
  }

  const artifact = await loadSettlementArtifact();
  const { mined, transactions } = createReceiptRecorder();
  const buyerSigner = await provider.getSigner(integerFlag(flags, "buyer-index", 0));
  await requireRole(buyerSigner, checkpoint.order.buyer, "BUYER_NOT_AUTHORIZED");
  const buyerNonceBefore = await provider.getTransactionCount(checkpoint.order.buyer, "latest");

  // markVerified is permissionless once a trusted attestation exists, so a relayer can pay the
  // fixed payee while the buyer process stays idle.
  const relayer = await provider.getSigner(integerFlag(flags, "relayer-index", 3));
  const relayerAddress = await relayer.getAddress();
  const contract = settlementAt({ address: checkpoint.contractAddress, abi: artifact.abi, runner: relayer });
  if (chainStatus.state === 2) {
    await mined(contract.markVerified(
      checkpoint.orderId, `0x${checkpoint.orderDigest.slice(7)}`, toBytes32(verification.ciphertextCommitment),
      `0x${verification.evidenceDigest.slice(7)}`, bundle.attestation.signature,
    ), "markVerified");
  }
  await mined(contract.settle(checkpoint.orderId), "settle");
  const last = transactions.at(-1);
  const payeeBefore = await provider.getBalance(checkpoint.order.payee, last.blockNumber - 1);
  const payeeAfter = await provider.getBalance(checkpoint.order.payee, last.blockNumber);
  const buyerNonceAfter = await provider.getTransactionCount(checkpoint.order.buyer, "latest");
  await recordStep(paths.workflow, { step: "release", action: "settle", orderId: checkpoint.orderId, transactions, buyerNonceBefore, buyerNonceAfter });
  return {
    ok: true, step: "release", action: "settle", orderId: checkpoint.orderId, relayerAddress,
    transactions, buyerNonceBefore, buyerNonceAfter, buyerTransactionsAfterCheckpoint: buyerNonceAfter - buyerNonceBefore,
    payeeBalanceBeforeWei: String(payeeBefore), payeeBalanceAfterWei: String(payeeAfter), payeeCreditWei: String(payeeAfter - payeeBefore),
    escrowBalanceAfterWei: String(await provider.getBalance(checkpoint.contractAddress, last.blockNumber)),
    chainStateBeforeRelease: chainStatus.stateName,
  };
}

/// Timeout refund. Needs the durable checkpoint and the chain, and deliberately never reads a
/// provider bundle: a provider that never delivered must not be able to block the buyer's refund.
async function refund(flags) {
  const rpc = requiredFlag(flags, "rpc");
  const paths = workflowPaths(requiredFlag(flags, "dir"));
  const checkpoint = await loadCheckpoint(paths);
  const { provider, artifact, chainStatus } = await chainContext(paths, rpc);
  if (!chainStatus.ok) {
    return { ok: false, step: "refund", code: chainStatus.code, message: chainStatus.message, retryable: chainStatus.retryable };
  }
  const next = nextSettlementAction(chainStatus);
  if (next.action !== "refund") {
    return {
      ok: false, step: "refund", code: "CHAIN_NOT_READY", retryable: true,
      state: chainStatus.stateName, nextAction: next.action,
      message: `refund is not the next legal action: ${next.reason}`,
    };
  }

  const buyerSigner = await provider.getSigner(integerFlag(flags, "buyer-index", 0));
  await requireRole(buyerSigner, checkpoint.order.buyer, "BUYER_NOT_AUTHORIZED");
  const contract = settlementAt({ address: checkpoint.contractAddress, abi: artifact.abi, runner: buyerSigner });
  const { mined, transactions } = createReceiptRecorder();
  const receipt = await mined(contract.refund(checkpoint.orderId), "refund");
  const buyerBefore = await provider.getBalance(checkpoint.order.buyer, receipt.blockNumber - 1);
  const buyerAfter = await provider.getBalance(checkpoint.order.buyer, receipt.blockNumber);
  const payeeBefore = await provider.getBalance(checkpoint.order.payee, receipt.blockNumber - 1);
  const payeeAfter = await provider.getBalance(checkpoint.order.payee, receipt.blockNumber);
  await recordStep(paths.workflow, { step: "refund", orderId: checkpoint.orderId, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, transactions });

  return {
    ok: true, step: "refund", action: "refund", orderId: checkpoint.orderId,
    chainStateBeforeRefund: chainStatus.stateName,
    transactionHash: receipt.hash, blockNumber: receipt.blockNumber, transactions,
    buyerBalanceBeforeWei: String(buyerBefore), buyerBalanceAfterWei: String(buyerAfter),
    transactionFeeWei: String(receipt.fee ?? 0n), payeeCreditWei: String(payeeAfter - payeeBefore),
    escrowBalanceAfterWei: String(await provider.getBalance(checkpoint.contractAddress, receipt.blockNumber)),
    bundleRequired: false, bundleRead: false, deliveryObserved: false,
  };
}

async function recover(flags) {
  const paths = workflowPaths(requiredFlag(flags, "dir"));
  const checkpoint = await loadCheckpoint(paths);
  const bundle = await readJson(paths.bundle, "bundle.json");
  const key = await readJson(paths.recipientKey, "recipient-key.json");
  const recovered = await recoverEncryptedResult(bundle, { ...checkpoint.trust, recipientPrivateKey: key.recipientPrivateKey });
  if (!recovered.ok) return { ok: false, step: "recover", code: recovered.code, message: "offline recovery failed" };
  await writeJson(paths.recovery, {
    schemaVersion: 1, orderId: checkpoint.orderId, orderDigest: recovered.orderDigest,
    ciphertextCommitment: recovered.ciphertextCommitment, result: recovered.result, evaluation: recovered.evaluation,
    settlementStatus: "not-queried", rpcRequired: false, providerCallbackRequired: false, recoveredAt: new Date().toISOString(),
  });
  return {
    ok: true, step: "recover", orderId: checkpoint.orderId, result: recovered.result, evaluation: recovered.evaluation,
    settlementStatus: "not-queried", rpcRequired: false, providerCallbackRequired: false, recoveryFile: paths.recovery,
  };
}

const handlers = { init, fund, status, verify, release, refund, recover };

const { command, flags } = (() => {
  try {
    return parseArgs(process.argv.slice(2), COMMANDS);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, step: "usage", code: error.code, message: error.message, commands: COMMANDS }));
    process.exit(2);
  }
})();

await runCli(command, () => handlers[command](flags));

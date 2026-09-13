import { buildEvidence } from "./evidence.mjs";
import { evaluateAllocation } from "./evaluator.mjs";
import { hex, isValidOrderSnapshot, isValidOrderSpec, orderDigest, snapshotCommitment } from "./order.mjs";
import { sealResult, sealedResultCommitment } from "./sealed-result.mjs";

function reject(code, message) {
  return { ok: false, error: { code, message } };
}
function snapshotAllocations(allocations) {
  if (!Array.isArray(allocations)) return allocations;

  return Array.from(allocations, (allocation) => {
    if (!allocation || (typeof allocation !== "object" && typeof allocation !== "function")) {
      return allocation;
    }

    return {
      target: allocation.target,
      amountMinorUnits: allocation.amountMinorUnits,
    };
  });
}

export async function prepareProviderSubmission({
  order,
  allocations,
  recipientPublicKey,
}) {
  if (!order || typeof order !== "object" || Array.isArray(order) || !Object.hasOwn(order, "snapshot")) {
    return reject("INVALID_ORDER", "A complete order with its input snapshot is required.");
  }
  if (!isValidOrderSnapshot(order.snapshot)) {
    return reject("INVALID_ORDER", "Order snapshot does not match the fixed allocation schema.");
  }
  if (order.inputCommitment !== snapshotCommitment(order.snapshot)) {
    return reject("INPUT_COMMITMENT_MISMATCH", "Order input commitment does not match its snapshot.");
  }
  if (!isValidOrderSpec(order)) {
    return reject("INVALID_ORDER", "Order does not match the fixed task and settlement schema.");
  }
  if (order.recipientPublicKey !== undefined && order.recipientPublicKey !== recipientPublicKey) {
    return reject("RECIPIENT_KEY_MISMATCH", "Recipient key does not match the order.");
  }

  let sealedAllocations;
  try {
    sealedAllocations = snapshotAllocations(allocations);
  } catch {
    return reject("INVALID_ALLOCATION_INPUT", "Allocation data must be readable.");
  }

  const evaluation = evaluateAllocation({
    snapshot: order.snapshot,
    allocations: sealedAllocations,
  });
  if (!evaluation.ok) {
    return reject(evaluation.code, evaluation.message);
  }
  const orderDigestHex = `0x${hex(await orderDigest(order))}`;

  const result = {
    allocations: sealedAllocations.map(({ target, amountMinorUnits }) => ({ target, amountMinorUnits })),
  };
  const sealedResult = await sealResult({
    plaintext: Buffer.from(JSON.stringify(result)),
    recipientPublicKey,
    orderDigest: orderDigestHex,
  });
  const ciphertextCommitment = sealedResultCommitment(sealedResult);
  const evidence = buildEvidence({
    orderDigest: `sha256:${sealedResult.orderDigest.slice(2)}`,
    ciphertextCommitment: `sha256:${ciphertextCommitment.slice(2)}`,
    evaluation,
  });

  return { ok: true, orderDigestHex, evaluation, sealedResult, ciphertextCommitment, evidence };
}

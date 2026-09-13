// SettlementStatus (spec "Required objects"): funding, verification and delivery are reported
// independently, every failure carries a stable code plus a retryable flag, and the next legal
// action is derived from the contract state instead of from an in-process boolean.
//
// What this module deliberately does NOT do: it never reports delivery. The settlement contract
// records a ciphertext commitment and a verifier attestation; neither observes that the buyer
// decrypted a valid result. `delivery.observed` is therefore always false here, and callers that
// need delivery must supply independent evidence.
import { ZERO_HASH } from "./constants.mjs";

export const SETTLEMENT_FAILURES = Object.freeze({
  RPC_UNAVAILABLE: Object.freeze({ retryable: true, message: "The chain endpoint could not be read; the local state is unknown." }),
  ORDER_NOT_FOUND: Object.freeze({ retryable: true, message: "No funded order exists for this id yet." }),
  CHAIN_MISMATCH: Object.freeze({ retryable: false, message: "The read came from a different chain id than the order binds." }),
  CONTRACT_MISMATCH: Object.freeze({ retryable: false, message: "The read came from a different settlement contract than the order binds." }),
  VERIFIER_MISMATCH: Object.freeze({ retryable: false, message: "The settlement contract names a different verifier than the order binds." }),
  ORDER_DIGEST_MISMATCH: Object.freeze({ retryable: false, message: "The funded order digest does not match the checkpointed order." }),
  UNEXPECTED_STATE: Object.freeze({ retryable: false, message: "The contract reported a state outside the frozen state machine." }),
});

const STATE_NAMES = Object.freeze(["None", "Funded", "Submitted", "Verified", "Settled", "Refunded"]);
const DELIVERY_REASON =
  "The settlement contract records a ciphertext commitment and a verifier attestation; it cannot observe that the buyer decrypted a valid result.";

export function retryableFailure(code) {
  return SETTLEMENT_FAILURES[code]?.retryable ?? false;
}

function failure(code, cause) {
  const entry = SETTLEMENT_FAILURES[code];
  const rejected = { ok: false, code, message: entry.message, retryable: entry.retryable };
  if (cause !== undefined) rejected.cause = cause;
  return rejected;
}

function zeroHash(value) {
  return typeof value === "string" && value.toLowerCase() === ZERO_HASH;
}

export function buildSettlementStatus({
  orderId,
  chainId,
  contractAddress,
  verifierAddress,
  verificationGrace,
  now,
  record,
  expectedChainId,
  expectedContractAddress,
  expectedVerifierAddress,
  expectedOrderDigest,
}) {
  const state = Number(record.state);
  if (!Number.isSafeInteger(state) || state < 0 || state >= STATE_NAMES.length) {
    return failure("UNEXPECTED_STATE");
  }
  const amountWei = String(record.amount);
  const notFound = state === 0 && zeroHash(record.orderDigest) && BigInt(amountWei) === 0n;
  if (notFound) return failure("ORDER_NOT_FOUND");
  if (expectedChainId !== undefined && Number(expectedChainId) !== Number(chainId)) return failure("CHAIN_MISMATCH");
  if (expectedContractAddress !== undefined
    && String(expectedContractAddress).toLowerCase() !== String(contractAddress).toLowerCase()) {
    return failure("CONTRACT_MISMATCH");
  }
  if (expectedVerifierAddress !== undefined
    && String(expectedVerifierAddress).toLowerCase() !== String(verifierAddress).toLowerCase()) {
    return failure("VERIFIER_MISMATCH");
  }
  if (expectedOrderDigest !== undefined && String(record.orderDigest).toLowerCase() !== String(expectedOrderDigest).toLowerCase()) {
    return failure("ORDER_DIGEST_MISMATCH");
  }

  const deadline = Number(record.deadline);
  const verificationDeadline = deadline + Number(verificationGrace);
  const funded = state === 1 || state === 2 || state === 3 || state === 4;
  const submitted = state === 2 || state === 3 || state === 4;
  const verified = state === 3 || state === 4;
  const terminal = state === 4 || state === 5;

  return {
    ok: true,
    orderId,
    chainId: Number(chainId),
    contractAddress,
    verifierAddress,
    state,
    stateName: STATE_NAMES[state],
    terminal,
    funding: {
      funded,
      amountWei,
      buyer: record.buyer,
      provider: record.provider,
      payee: record.payee,
      deadline,
      deadlineReached: Number(now) >= deadline,
    },
    verification: {
      submitted,
      verified,
      ciphertextCommitment: record.ciphertextCommitment,
      evidenceDigest: record.evidenceDigest,
      verificationGraceSeconds: Number(verificationGrace),
      verificationDeadline,
      windowOpen: Number(now) < verificationDeadline,
    },
    delivery: {
      observed: false,
      source: "chain-observes-no-delivery",
      reason: DELIVERY_REASON,
    },
    errors: [],
  };
}

/// Enforces the reporting invariant: no code path may turn verification into delivery.
export function assertStatusSeparation(status) {
  if (status.ok !== true) {
    throw Object.assign(new Error(`STATUS_NOT_OK: cannot assert separation on a failed status read`), { code: "STATUS_NOT_OK" });
  }
  if (status.delivery.observed !== false || status.delivery.source !== "chain-observes-no-delivery") {
    throw Object.assign(new Error("DELIVERY_INFERRED_FROM_CHAIN: delivery must be reported from independent evidence"), {
      code: "DELIVERY_INFERRED_FROM_CHAIN",
    });
  }
  if (status.verification.verified && status.delivery.observed) {
    throw Object.assign(new Error("DELIVERY_INFERRED_FROM_CHAIN: verification is not delivery"), {
      code: "DELIVERY_INFERRED_FROM_CHAIN",
    });
  }
  return true;
}

export function nextSettlementAction(status) {
  if (status?.ok !== true) {
    const code = status?.code ?? "RPC_UNAVAILABLE";
    if (code === "ORDER_NOT_FOUND") {
      return {
        action: "fund", actor: "buyer", retryable: true, code,
        reason: `${code}: no funded order exists for this id yet; the buyer may fund the frozen order.`,
      };
    }
    const retryable = status?.retryable ?? retryableFailure(code);
    return {
      action: retryable ? "retry-read" : "stop",
      actor: "none",
      retryable,
      reason: `${code}: ${status?.message ?? SETTLEMENT_FAILURES.RPC_UNAVAILABLE.message}`,
      code,
    };
  }
  const { state, funding, verification, terminal } = status;
  if (terminal) {
    return { action: "complete", actor: "none", retryable: false, reason: `Order is terminal (${status.stateName}).` };
  }
  if (state === 0) {
    return { action: "fund", actor: "buyer", retryable: true, reason: "No funded order exists yet; the buyer funds the frozen order." };
  }
  if (state === 1) {
    if (funding.deadlineReached) {
      return {
        action: "refund", actor: "buyer-or-provider", retryable: true,
        reason: "The submission deadline passed with no submission; the buyer or provider can refund.",
      };
    }
    return { action: "await-submission", actor: "provider", retryable: true, reason: "The order is funded and inside the submission window." };
  }
  if (state === 2) {
    if (verification.windowOpen) {
      return {
        action: "await-verification", actor: "verifier", retryable: true,
        reason: `A submission is pending; the verifier window stays open until ${verification.verificationDeadline}.`,
      };
    }
    return {
      action: "refund", actor: "anyone", retryable: true,
      reason: "The verifier window closed without a valid attestation; anyone may refund the buyer.",
    };
  }
  return {
    action: "settle", actor: "anyone", retryable: true,
    reason: "A trusted verifier attestation is recorded; any caller can pay the fixed payee.",
  };
}

const STRUCT_FIELDS = ["buyer", "provider", "payee", "amount", "deadline", "state", "orderDigest", "ciphertextCommitment", "evidenceDigest"];

/// Chain-backed read used by the buyer/provider/verifier CLIs.
export async function readSettlementStatus({ contract, orderId, expected = {}, now }) {
  try {
    const provider = contract.runner?.provider ?? contract.runner;
    const [raw, grace, verifierAddress, blockNumber, block] = await Promise.all([
      contract.orders(orderId),
      contract.VERIFICATION_GRACE(),
      contract.verifier(),
      provider.getBlockNumber(),
      provider.getBlock("latest"),
    ]);
    const record = Object.fromEntries(STRUCT_FIELDS.map((field, index) => [field, raw[field] ?? raw[index]]));
    return buildSettlementStatus({
      orderId,
      chainId: expected.expectedChainId ?? Number((await provider.getNetwork()).chainId),
      contractAddress: expected.expectedContractAddress ?? await contract.getAddress(),
      verifierAddress,
      verificationGrace: Number(grace),
      now: now ?? Number(block.timestamp),
      record: { ...record, amount: String(record.amount), deadline: Number(record.deadline), state: Number(record.state) },
      ...expected,
    });
  } catch (error) {
    return failure("RPC_UNAVAILABLE", error?.shortMessage ?? error?.message);
  }
}

export { STATE_NAMES };

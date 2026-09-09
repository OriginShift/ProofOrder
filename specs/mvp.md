# ProofOrder MVP Specification

Status: draft, created 2026-09-09 HKT

## Goal

Demonstrate one complete agent-to-agent work order in which a buyer can verify that a sealed result satisfies a fixed deterministic rule before settlement, while retaining a local recovery bundle.

## Scope

- One fixed task adapter: constrained allocation over a frozen input snapshot.
- G0 freezes the first task rules at 10,000 integer budget units, 6,000 maximum per target, 5,000 minimum liquidity bps, and 7,500 minimum weighted score bps. These are demo parameters, not investment advice.
- One buyer process and one provider process with separate identities.
- One deterministic evaluator and one real proof system selected by the first experiment.
- One settlement chain and test asset selected after the proof and exchange feasibility checks.
- A workbench showing task rules, order state, proof state, settlement state, and recovery state.

Out of scope: a marketplace, bidding, multiple task types, multi-chain support, real investment execution, generic natural-language contracts, token issuance, complete zkML, and claims of production security.

## Required objects

`OrderSpec` binds version, nonce, chain ID, settlement contract, buyer, provider, payee, task type, input commitment, rule ID, verifier version, asset, fee, deadline, and settlement condition using domain-separated canonical encoding.

`SealedResult` binds the order reference, ciphertext, encryption/encoding version, nonce and authentication data, ciphertext commitment, and unlock-condition reference.

`VerificationEvidence` contains the proof system/version, verifier ID, public inputs, proof, and order digest. Public inputs must bind the actual delivered ciphertext bytes and the order.

`RecoveryBundle` contains order/rule metadata, the locally saved ciphertext, evidence, chain/contract information, and recovery/query locator. It never contains a wallet private key.

`SettlementStatus` reports funding, verification, and delivery independently. Errors use stable codes and state whether retry is allowed.

## Frozen G0 state machine

`DRAFT -> FUNDED -> SUBMITTED -> VERIFIED -> DELIVERED -> SETTLED` is the successful path. `FUNDED -> REFUNDED` is allowed only after the fixed deadline with no valid submission. `SUBMITTED -> REJECTED` is terminal for that submission and may move to a pre-deadline retry according to the retry policy. `FUNDED -> CANCELLED` is not an allowed buyer shortcut. Settlement and refund are mutually exclusive and every transition is scoped to the order digest, chain ID, contract, verifier version, and fixed payee.

## Frozen offline checkpoint

Before any settlement or release action, the buyer must durably save the complete `RecoveryBundle` locally: order bytes and digest, ciphertext, nonce/IV and authentication data, wrapped key, proof/evidence, chain and contract identifiers, and the retrieval locator. The buyer may then stop responding. Recovery uses only the saved bundle, the buyer private key, and queryable chain state; it must not require a provider callback. This checkpoint does not promise recovery after local deletion or unavailable external storage.

## Acceptance gates

1. A valid result produces valid evidence, settlement, and buyer-side recovery.
2. Invalid rule results, empty/negative/out-of-range values, changed input, changed rule/version, changed order, changed payee, and replaced ciphertext fail closed.
3. Duplicate submit/settle and cross-domain replay fail.
4. Provider abort exits according to a fixed timeout rule; funds do not remain indefinitely locked.
5. A failed transaction or near-deadline case is tested for secret leakage. If the mechanism cannot prevent free disclosure under the declared threat model, the claim is narrowed and the failure is recorded.
6. A clean environment can reproduce success, rejection, and recovery from the README.

## Explicit assumptions

This MVP proves only the fixed rule and the stated exchange assumptions. It does not prove global optimality, input truth, future returns, LLM correctness, data availability after local deletion, or production readiness.

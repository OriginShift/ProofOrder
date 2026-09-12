# Submitted Verification Grace

Date: 2026-09-12 HKT
Executor: Codex. Human acceptance: pending.

## Finding

Before this change, a provider could submit before the order deadline, yet the buyer could refund immediately after the deadline while verifier processing was still in flight. This made a submitted order refundable during the normal verifier delay.

## Change

The contract now exposes `VERIFICATION_GRACE = 1 hour`. A `Funded` order remains refundable at its deadline. A `Submitted` order can be refunded only after `deadline + VERIFICATION_GRACE`; `markVerified` is rejected at or after that same boundary. This bounds the verifier window and removes the immediate Submitted-state refund race. It does not solve buyer prepayment decryption or guarantee provider payment after delivery.

## Validation

- Foundry tests cover chain-domain separation, Submitted refund before and after the grace period, and verification after grace; all contract tests passed.
- JavaScript failure flow asserts `DeadlineNotReached` during the grace period and then completes both refunds after advancing past it.
- Encrypted delivery demo still settles successfully; its provider-abort counterexample now advances past the configured grace before refunding.
- The refreshed machine-readable reports at [0011 encrypted delivery](../runs/0011-encrypted-delivery.json) and [0011 failure regression](../runs/0011-failure-regression.json) match the current source hashes.

## Boundary

The one-hour value is a demo policy, not a universal timeout. A verifier outage longer than the grace loses the Submitted order's ability to settle. A `Verified` order remains non-refundable and buyer settlement is still a separate transaction. Public mempool ordering, public testnet finality, reorgs and full fair exchange remain unproven.

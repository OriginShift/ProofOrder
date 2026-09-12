# Decision 0014: Verified settlement liveness

Date: 2026-09-12 HKT

## Problem

The first settlement implementation required the buyer to call `settle` after a verifier had already authorized an order. That left funds dependent on buyer availability even though the contract already stored the payee and amount.

## Decision

Remove the buyer-only caller check from `settle`. Once `markVerified` accepts the verifier's EIP-191 signature, any caller may execute the one-way payment. The contract keeps the funded `payee` and `amount` in storage, changes state before the external call, reverts on transfer failure, and rejects every later settlement or refund.

This makes relaying possible and preserves the buyer-offline path. It does not make the verifier trustless, prove delivery, or solve the earlier HPKE exchange failure: the buyer can still decrypt a complete bundle before payment and then obtain a timeout refund if verification never occurs. A recipient that permanently rejects native transfers can still block payout.

## Evidence

- `npm test`: 84 passed.
- `forge test -vv`: 24 passed, including `test/SettlementLiveness.t.sol` (12 tests and a 256-run arbitrary-caller fuzz test).
- `npm run demo`: passed. The machine-readable trace is [`0014-verified-settlement.json`](../runs/0014-verified-settlement.json).
- `npm run demo:failures`: passed; the existing rejection and funded/submitted refund boundaries remain valid.

The successful trace records a buyer nonce unchanged after the funding checkpoint, a verifier transaction, a relayer settlement after the one-hour grace, exact payee credit of 1 ETH, relayer gas, and zero escrow. The Foundry suite additionally covers fixed-payee redirection attempts, payout failure and retry, reentrancy, duplicate settlement, and Verified-state refund rejection.

## Remaining work

The next mechanism decision is payment-gated disclosure or an explicit final claim narrowing. Human contract review and clean-room reproduction remain required before submission.

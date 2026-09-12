# Chain Domain Separation

Date: 2026-09-12 HKT
Executor: Codex. Human acceptance: pending.

## Problem

The settlement contract's EIP-191 evidence hash previously included the contract address but omitted the chain ID. A verifier signature could therefore be replayed on a deployment at the same address on another chain if the surrounding order data matched.

## Change

`ProofOrderSettlement.evidenceMessageHash` now commits `block.chainid` before the contract address. The offline schema-2 recovery verifier uses the same ordered fields and requires the buyer's expected chain ID. Existing signatures are intentionally incompatible with the new domain and must be regenerated.

## Evidence

- `forge test -vv`: 8 tests passed, including `testEvidenceHashBindsChainId`, which changes the Foundry chain ID from 31337 to 1 and asserts distinct hashes.
- `npm test`: 84 tests passed. Encrypted recovery fixtures now construct and verify the seven-field domain hash including chain ID.
- `npm run demo`: passed with a fresh Anvil node; encrypted settlement reached `Settled`, payee credit was exactly 1 ETH, independent offline recovery returned score 7960, and the payment-gated counterexample remained reproduced.
- `npm run demo:failures`: passed with a fresh Anvil node; 10 exact rejection simulations and two timeout refunds passed.
- Reports were refreshed at [0011 encrypted delivery](../runs/0011-encrypted-delivery.json) and [0011 failure regression](../runs/0011-failure-regression.json). Their source hashes match the files in this revision.

## Boundary

This closes the omitted chain-domain field. It does not provide a public testnet replay transaction, a ZK proof, or full fair exchange. The recipient can still decrypt a complete HPKE bundle before payment, and the provider can still withhold a bundle after payment.

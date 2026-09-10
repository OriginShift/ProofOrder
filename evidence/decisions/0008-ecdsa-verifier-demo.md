# ECDSA Evidence Verifier Demo

Date: 2026-09-11 HKT
Commands: `forge test -vv`, `PROOFORDER_RPC_URL=http://127.0.0.1:8546 npm run demo`

## Result

- The contract reconstructs a domain-separated message containing its own address, order ID, order digest, ciphertext commitment, and evidence digest.
- The verifier signs that message with ECDSA; the buyer relays the signature to `markVerified`.
- `ecrecover` rejects empty, wrong, and mismatched-evidence signatures.
- Foundry: 7/7 tests passed.
- Local Anvil demo reached `Settled` (state 4), left the settlement contract at `0` wei, and increased the provider balance by `999938959545656260` wei after provider gas.

## Claim boundary

This is an ECDSA-signed deterministic evaluator attestation. It proves who authorized the evidence digest, not that the evaluator computation was performed inside a zero-knowledge proof. The verifier signer and evaluator remain trusted until a real proof system replaces this adapter.

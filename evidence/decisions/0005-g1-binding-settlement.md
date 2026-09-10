# G1 Evidence Binding Settlement Run

Date: 2026-09-11 HKT
Commands: `forge test -vv`, `npm test`

## Result

- Foundry: 6/6 tests passed with solc 0.8.24.
- Node: 7/7 tests passed.
- The verifier-gated transition now requires the submitted order digest, ciphertext commitment, and a non-empty evidence digest to match the funded order.
- Mismatched ciphertext evidence is rejected.

## Boundary

The configured verifier address is an authorization boundary, not a cryptographic proof verifier. The next G1 task is to implement and connect a real verifier; until then, the repository must not claim that the contract independently proves the allocation predicate.

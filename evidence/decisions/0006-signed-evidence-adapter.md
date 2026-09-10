# G1 Signed Evidence Adapter

Date: 2026-09-11 HKT
Command: `npm test`
Environment: Node v25.9.0

## Result

Eight Node tests passed. The new evidence builder computes a domain-separated digest over the order digest, actual ciphertext commitment, and deterministic evaluator output. Mutating either the ciphertext commitment or the evaluation changes the evidence digest.

## Claim boundary

`signed-deterministic-evaluator-v1` is a fallback attestation format for wiring the demo. It is not a zero-knowledge proof and does not remove trust in the configured verifier. Before submission, either connect a real proof verifier or describe this trust boundary prominently and treat the ZK goal as incomplete.

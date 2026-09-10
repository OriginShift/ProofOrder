# G1 Evidence Digest Adapter

Date: 2026-09-11 HKT
Command: `npm test`
Environment: Node v25.9.0

## Result

Eight Node tests passed. The new evidence builder computes a domain-separated digest over the order digest, actual ciphertext commitment, and deterministic evaluator output. Mutating either the ciphertext commitment or the evaluation changes the evidence digest.

## Claim boundary

`deterministic-evaluator-evidence-v1` is a fallback digest format for wiring the demo. It is not a signature or zero-knowledge proof and does not remove trust in the configured verifier. Before submission, either connect a real proof verifier or describe this trust boundary prominently and treat the ZK goal as incomplete.

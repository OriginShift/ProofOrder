# Decision 0015: Payment-gated disclosure candidate

Date: 2026-09-12 HKT

## Experiment

The direct HPKE bundle gives the buyer all material needed to decrypt before payment. This experiment separates the result ciphertext from a random AES-256-GCM data key. The public bundle contains the ciphertext, nonce, authentication tag, order-bound key commitment, and buyer-pinned envelope commitment, but not the data key. A post-settlement provider release supplies the key.

## Result

The buyer cannot decrypt the public bundle before key release (`KEY_UNAVAILABLE`). After release, the key commitment, ciphertext commitment, order digest, and authenticated ciphertext all verify and the result decrypts. The same bundle still cannot decrypt if the provider withholds the key after receiving payment (`KEY_UNAVAILABLE`).

This is a useful payment-gated disclosure primitive, but it is not fair exchange. It moves the liveness risk from premature buyer disclosure to provider withholding after payment. A production design would need an enforceable release mechanism, a dispute/refund path, or a trusted threshold/TEE service; this repository does not claim to implement one.

## Evidence

- `npm run experiment:payment-gated`: passed on a fresh Anvil; both release and withholding traces mined fund, submit, verify, and relayer-settle transactions.
- `npm test`: 112 passed, including 28 focused payment-gated tests.
- Machine-readable output: [`0015-payment-gated-disclosure.json`](../runs/0015-payment-gated-disclosure.json).

## Decision

Do not replace the demonstrated local HPKE path with this candidate before submission. Keep the candidate as an explicit failure experiment, narrow the fair-exchange claim, and prioritize clean-room reproduction, human review, and the final demo. Revisit only if a release mechanism with an enforceable timeout can be implemented and tested independently.

# G0 HPKE Binding Experiment

Date: 2026-09-10 HKT
Command: `npm test`
Environment: Node v25.9.0, npm 11.12.1, `@hpke/core` 1.9.0, `@hpke/dhkem-x25519` 1.8.0

## Result

- 20/20 HPKE encrypt, wrap, unwrap, and AEAD decrypt rounds passed.
- Suite: DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM.
- Ciphertext mutation was rejected by AEAD authentication.
- Order/AAD mutation was rejected by AEAD authentication.
- Wrapped-key mutation was rejected by HPKE authentication.
- The experiment produced an order digest and ciphertext commitment in its JSON output; the values are run-specific and are not chain receipts.

## G0 disposition

The HPKE path is **GO for G1 integration** under the declared assumptions. G0 is **not fully closed** until the settlement state machine is implemented and tested against a local chain. No proof system or Solidity verifier has been claimed by this experiment.

## Human review required

Qy must review the canonical encoding and buyer checkpoint. Teammate A must review the transition invariants before contract implementation. Teammate B must independently rerun `npm test` and confirm the negative cases.

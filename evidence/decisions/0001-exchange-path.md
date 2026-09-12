# Exchange Path Decision

Date: 2026-09-09 HKT

Update, 2026-09-12: this initial candidate has failed the full fair-exchange goal. [Decision 0011](0011-encrypted-recovery-and-exchange-boundary.md) records a runnable counterexample: the buyer decrypts the complete HPKE package before payment and later refunds when the provider stops before verification is mined. The original rationale below protects against plaintext-key disclosure to outsiders; it did not address prepayment access by the intended recipient.

## Decision under test

Use AEAD for the result and RFC 9180 HPKE to wrap the AEAD key to the buyer. Bind the ciphertext, wrapped key, order digest, and proof inputs to the same canonical order bytes. Release payment after the sealed package and valid evidence are submitted; refund on a fixed timeout if submission does not happen.

## Why

A public-mempool hash-locked reveal can expose a plaintext key before the payment transaction is final. A buyer can observe the pending key, race a refund, and decrypt for free. That path cannot carry an unconditional fair-exchange claim under the public-mempool threat model.

HPKE avoids putting the plaintext key on chain. It narrows the guarantee to buyer key secrecy, correct mature libraries, and availability of the ciphertext/package. It does not prevent a buyer from copying a result after legitimate decryption and is not a production security audit.

## Go/no-go measurements

- 20 or more end-to-end HPKE encrypt/wrap/unwrap/decrypt cycles.
- Mutating ciphertext, wrapped key, order digest, or AAD causes verification or decryption failure.
- Anvil tests cover escrow submit, settle, duplicate calls, provider abort, and timeout refund.
- Record commands, versions, timings, gas, traces, and reviewer in this directory before moving to G1.

## Alternatives and attribution

The threat observation is consistent with the published FairSwap/ZKCP line of work. FairSwap and RFC 9180 are research/standards references, not team-authored code. If external packages are integrated, their exact versions and licenses will be recorded in the repository.

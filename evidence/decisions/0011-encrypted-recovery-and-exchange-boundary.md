# Encrypted Recovery and Exchange Boundary

Date: 2026-09-12 HKT
Executor: Codex. Review: a separate Codex agent; its snapshot-serialization finding was fixed and regression-tested. Human acceptance: pending.

## Result and decision

Real recipient encryption, local settlement and independent offline recovery now run together. Full fair exchange does not: a complete HPKE delivery is already decryptable by the intended buyer. With provider abort before on-chain verification, that buyer can then refund the escrow. This is an observed failure of the original exchange candidate, not a resolved security issue.

The [encrypted-flow report](../runs/0011-encrypted-delivery.json) includes the exact source hashes, public bundles and signatures, transaction/block hashes, inputs, decrypted fixture outputs and measured balances. The [failure-run regression report](../runs/0011-failure-regression.json) records both timeout refunds after sharing the node lifecycle wrapper. Private recipient keys are excluded from both reports.

## Implemented path

1. The buyer's order binds the actual chain ID, deployed contract, parties, payee, verifier, random nonce, native payment amount, deadline, input snapshot/commitment and recipient public key. Snapshot commitments use recursively sorted JSON and the `ProofOrder/InputSnapshot/v1` domain. The legacy digest helper retains its defaults, but this flow supplies those fields explicitly.
2. `sealed-result.mjs` uses the installed HPKE implementation with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM. It encrypts result bytes directly and commits the full envelope with a versioned SHA-256 domain. HPKE `info` and AAD bind the suite, version, order digest and recipient metadata.
3. The trusted verifier signs the contract's EIP-191 evidence hash. Schema-2 recovery re-derives the order, envelope and evidence hashes and checks the signature against the buyer's separately saved trusted context. The envelope carries the complete authenticated ciphertext and encapsulation; no application plaintext unlock key is published.
4. Bundle, context and a separate recipient-key file are durably saved before funding. Writes use mode `0600`, temporary files, file sync, atomic rename and directory sync. The demo then funds, submits, verifies and settles.
5. A fresh recovery process reads only the three saved files. It verifies the attestation, decrypts allocations, uses the signed order snapshot for evaluation, and returns score 7960 for budget 10000. It reports payment as `not-queried`, and does not call a provider or RPC endpoint.

The main flow still orchestrates buyer, provider and verifier together. These are not independent agent processes. The verifier can see the fixture result. The public two-target fixture, clear score and published result cannot establish practical result secrecy; the encrypted bytes demonstrate the transport/recovery mechanism only.

## Counterexample

The second order follows this trace, all on a fresh local Anvil:

1. Provider encrypts and supplies a valid signed recovery bundle. Buyer funds 1 ETH; provider submits its envelope commitment.
2. No verification transaction is sent. The chain remains `Submitted` with zero evidence digest. The buyer directly decrypts the complete envelope, and the recovery API also accepts the signed bundle without implying payment.
3. The provider remains offline. The test advances to deadline + 1 and mines the buyer's refund.
4. The buyer retains the decrypted result and receives exactly 1 ETH including the gas adjustment. The provider receives no payment; the contract ends at zero balance and the order is `Refunded`.

This requires provider/verifier abort or non-inclusion before `markVerified`, and is not evidence of a mempool front-running attack against an active provider. It is sufficient to reject the full fair-exchange claim under the declared abort model. Adding a local payment check before decryption cannot fix it: a buyer can invoke HPKE directly. [RFC 9180, sections 5 and 6](https://www.rfc-editor.org/rfc/rfc9180.html#section-5) describes recipient encryption/decryption; it includes no chain-payment gate.

## Validation

- `npm test`: 84 tests passed, including 15 HPKE tests, 50 schema-2 recovery tests and four node-lifecycle tests. Tests cover invalid signatures, replaced commitments, modified evidence/metadata, wrong recipient keys, wrong trusted contexts, invalid snapshots, re-evaluation mismatch, property-order-independent commitments and atomic persistence failure.
- `forge test -vv`: 7 existing contract tests passed. The contract is unchanged. Timestamp lint warnings remain.
- `npm run demo`: success payout of exactly 1 ETH, recovery score 7960, and prepayment-decryption/refund counterexample all asserted. A successful process exit means the experiments matched their assertions, including the expected security failure.
- `npm run demo:failures`: 10 exact rejection simulations and two mined timeout refunds passed; escrow 2 -> 1 -> 0 ETH.
- SIGINT is tested in a subprocess that owns an Anvil node; the node becomes unreachable and no success report is published. Timeout and pre-aborted input also leave no success report.

`npm run demo` creates fresh random recipient keys, nonces and HPKE encapsulations, so reruns produce different hashes. Use the report's paths to rerun offline recovery after Anvil stops. Old schema-1 recovery remains a hash-only compatibility API; the new demo exclusively uses schema 2.

## Remaining requirements

G1/G2 are not accepted. The next design decision must address payment/release ordering, provider abort after delivery, and the `Verified` state where only the buyer can settle and no refund is permitted. It must also address explicit on-chain domain separation. Making verification and payment atomic could remove one intermediate state, but it alone does not gate a package that the buyer has already received. Any revised mechanism needs its own adversarial trace before a fair-exchange claim.

ZK proof generation, independent agent execution, external storage, retry after ambiguous transactions, public testnet finality and sponsor integrations remain outside this result. No human implementation/review is asserted by these AI-generated changes. The assigned team member still owns substantial settlement-state changes and adversarial contract tests.

## Dependencies and provenance

Existing dependencies, no new packages: `@hpke/core` 1.9.0, `@hpke/dhkem-x25519` 1.8.0, `@hpke/common` 1.10.1 and `ethers` 6.15.0, all MIT in the lockfile. HPKE implementation and construction are external library/standard work. The envelope format, order/recovery binding, demo and experiment assertions are project code; they are not a cryptographic audit.

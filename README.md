# ProofOrder

ProofOrder is an experimental framework for one verifiable work order between AI agents. A buyer locks a fixed task and acceptance rule; a provider submits a sealed result with evidence; the buyer can verify and recover the delivered bundle under the declared exchange assumptions.

This repository is an ETHOnline 2026 submission in active development. It is not audited, does not guarantee investment outcomes, and does not claim production security or unconditional fair exchange.

## Project documents

- [MVP specification](specs/mvp.md)
- [Execution plan](docs/EXECUTION_PLAN.md)
- [Acceptance evidence ledger](evidence/test-ledger.md)
- [AI use and human contribution record](docs/AI_USAGE.md)
- [Human-owned work items](docs/HUMAN_CONTRIBUTION.md)

The current `deterministic-evaluator-evidence-v1` adapter is authorized on chain by an ECDSA verifier signature. It is a trusted attestation, not a zero-knowledge proof; its replacement path is recorded in the evidence decisions.

## Run the local demo

Prerequisites: Node.js 22+, npm, and Foundry (`forge` and `anvil`) on `PATH`. Install the locked dependencies and contract test library:

```bash
npm ci
git submodule update --init --recursive
```

Run the encrypted delivery and exchange-boundary experiment:

```bash
npm run demo
```

The command starts a fresh local Anvil, deploys the contract, and runs two asserted traces:

- A valid encrypted delivery is signed by the trusted verifier, then settled for 1 ETH by an independent relayer after the buyer stops sending transactions and the verification grace has elapsed. The payee receives exactly 1 ETH at the settlement block; the relayer cannot redirect the fixed payee.
- A provider delivers the complete encrypted bundle and stops before verification is mined. The buyer decrypts while the order is `Submitted`, then takes a 1 ETH timeout refund. This is an intentional counterexample to full fair exchange, not a successful security property.

The report is `artifacts/encrypted-delivery.json`. The [recorded settlement run](evidence/runs/0014-verified-settlement.json) and [exchange decision](evidence/decisions/0011-encrypted-recovery-and-exchange-boundary.md) contain source hashes, public bundles, transaction hashes and measured balances. Anvil is stopped automatically; the saved files remain usable for offline recovery.

Encryption uses HPKE with X25519, HKDF-SHA256 and AES-256-GCM. The complete envelope commitment binds the suite, version, order digest, recipient key, encapsulation and ciphertext. Schema-2 recovery checks externally supplied order/chain/contract/verifier expectations, recomputes the order and evidence digests, verifies the ECDSA signature, decrypts, and re-evaluates allocations using the signed input snapshot.

The private decryption key is stored separately under the ignored `artifacts/encrypted-*` directory with mode `0600`. It is a local demo key, not a wallet key, and is never included in the recovery bundle or committed report. The bundle, key and trusted-context files are written before funding using atomic replacement and file/directory sync. Keep the trusted context from the buyer's own order checkpoint; a context supplied alongside an untrusted bundle is not an independent trust anchor.

To repeat recovery after the node has stopped, use the three paths printed in the report:

```bash
node scripts/recover-demo.mjs <bundle.json> <buyer-key.json> <trusted-context.json>
```

Recovery explicitly reports `settlementStatus: "not-queried"`; successful decryption or a valid signature does not prove payment or chain finality. The demo shows a buyer-offline settlement transaction, but buyer/provider execution is still one orchestration process, and the verifier sees the result. The small public fixture and published demo output are not intended to be secret. The old schema-1 hash-only helpers remain for compatibility and are not used by this demo.

## Run failure checks

The failure command starts a fresh Anvil node on an available loopback port and stops it on completion or failure:

```bash
npm run demo:failures
```

It checks an authorized-signature positive control and 10 exact contract rejections, then refunds a funded order and a submitted order after their deadlines. Refund events, receipt-block balances, buyer credit including gas, unchanged provider balance, and final zero escrow are asserted. A failed assertion or RPC error exits nonzero. The flow has a 60-second overall timeout and bounded RPC/receipt waits.

The settlement contract gives submitted orders a fixed one-hour `VERIFICATION_GRACE`: a submission made before the deadline cannot be refunded immediately while verifier processing is in flight, and verification after the grace is rejected. This bounds the verifier window; it does not resolve post-payment delivery withholding.

The generated report is `artifacts/failure-boundaries.json`; a new invocation removes the previous report so a failed run cannot leave stale success evidence. The [recorded run](evidence/decisions/0010-failure-boundaries-run.md) includes committed transaction hashes, inputs, source hashes and exact claim boundaries. Rejected calls are simulations; the refunds are mined local transactions.

To reuse a dedicated local Anvil, set `PROOFORDER_RPC_URL`. The command deploys a new contract each time and advances that node's clock past the orders' deadlines. It does not reset or stop a supplied node. Use a dedicated node with the default unlocked accounts and chain ID 31337; do not share it with another active demo.

```bash
npm test
forge test -vv
```

The encryption implementation uses the existing MIT-licensed `@hpke/core` 1.9.0 and `@hpke/dhkem-x25519` 1.8.0 packages, with `ethers` 6.15.0 for signing and chain access. The lockfile records exact dependencies. HPKE's recipient-encryption construction is described in [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html); it does not enforce a payment condition. See [the decision record](evidence/decisions/0011-encrypted-recovery-and-exchange-boundary.md) for the demonstrated exchange limitation.

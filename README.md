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

Start Anvil in one terminal:

```bash
anvil --port 8546
```

Run the settlement demo in another terminal:

```bash
PROOFORDER_RPC_URL=http://127.0.0.1:8546 npm run demo
```

The demo deploys a fresh settlement contract and runs the buyer/provider/verifier flow on local Anvil. See [the recorded run](evidence/decisions/0007-anvil-demo-flow.md) for the measured output and claim boundary.

The current settlement demo uses a JSON payload as a placeholder for ciphertext. Recovery checks stored hashes; it does not yet decrypt and re-evaluate a hidden result or verify a recovery bundle's signature. The separate `npm run g0` HPKE experiment is not integrated into this flow.

## Run failure checks

The failure command starts a fresh Anvil node on an available loopback port and stops it on completion or failure:

```bash
npm run demo:failures
```

It checks an authorized-signature positive control and 10 exact contract rejections, then refunds a funded order and a submitted order after their deadlines. Refund events, receipt-block balances, buyer credit including gas, unchanged provider balance, and final zero escrow are asserted. A failed assertion or RPC error exits nonzero. The flow has a 60-second overall timeout and bounded RPC/receipt waits.

The generated report is `artifacts/failure-boundaries.json`; a new invocation removes the previous report so a failed run cannot leave stale success evidence. The [recorded run](evidence/decisions/0010-failure-boundaries-run.md) includes committed transaction hashes, inputs, source hashes and exact claim boundaries. Rejected calls are simulations; the refunds are mined local transactions.

To reuse a dedicated local Anvil, set `PROOFORDER_RPC_URL`. The command deploys a new contract each time and advances that node's clock past the orders' deadlines. It does not reset or stop a supplied node. Use a dedicated node with the default unlocked accounts and chain ID 31337; do not share it with another active demo.

```bash
npm test
forge test -vv
```

The implementation and evidence will be updated in small, reviewable commits. Reused libraries and external research will be attributed with their licenses and links when integrated.

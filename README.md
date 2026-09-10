# ProofOrder

ProofOrder is an experimental framework for one verifiable work order between AI agents. A buyer locks a fixed task and acceptance rule; a provider submits a sealed result with evidence; the buyer can verify and recover the delivered bundle under the declared exchange assumptions.

This repository is an ETHOnline 2026 submission in active development. It is not audited, does not guarantee investment outcomes, and does not claim production security or unconditional fair exchange.

## Project documents

- [MVP specification](specs/mvp.md)
- [Execution plan](docs/EXECUTION_PLAN.md)
- [Acceptance evidence ledger](evidence/test-ledger.md)
- [AI use and human contribution record](docs/AI_USAGE.md)
- [Human-owned work items](docs/HUMAN_CONTRIBUTION.md)

The current `deterministic-evaluator-evidence-v1` adapter is a fallback integration boundary, not a signature or zero-knowledge proof. Its trust assumptions and replacement path are recorded in the evidence decisions.

## Run the local demo

```bash
anvil --port 8546
PROOFORDER_RPC_URL=http://127.0.0.1:8546 npm run demo
```

The demo deploys a fresh settlement contract and runs the buyer/provider/verifier flow on local Anvil. See [the recorded run](evidence/decisions/0007-anvil-demo-flow.md) for the measured output and claim boundary.

The implementation and evidence will be updated in small, reviewable commits. Reused libraries and external research will be attributed with their licenses and links when integrated.

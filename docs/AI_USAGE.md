# AI Use and Human Contribution Record

This project uses Codex as an implementation assistant. Human team members define the problem, choose scope and assumptions, select and review cryptographic and exchange mechanisms, run acceptance experiments, interpret failures, and approve releases.

For every AI-assisted change, record:

- date and contributor;
- tool/model and the prompt or task brief;
- files generated or modified;
- human decisions, edits, and review performed;
- commands run and their actual output;
- reviewer and acceptance status.

Human ownership boundaries are defined in [HUMAN_CONTRIBUTION.md](HUMAN_CONTRIBUTION.md). The goal is meaningful design, implementation, testing, and review by team members, not cosmetic authorship.

Do not describe AI-generated code as independently designed by a human. Do not claim a mechanism, audit, performance result, or sponsor integration until the repository contains the corresponding implementation and evidence.

## Initial session record

- 2026-09-09: Codex inspected the public `OriginShift/ProofOrder` repository and confirmed it contained only the initial README and MIT license.
- 2026-09-09: The team supplied the ProofOrder product specification and execution rules through Notion. Codex converted the agreed scope into `specs/mvp.md` and `docs/EXECUTION_PLAN.md`; the team remains responsible for the technical decisions and acceptance.
- 2026-09-11: Codex added the deterministic-evaluator evidence digest adapter and connected ECDSA signature recovery in the settlement contract. The team must decide whether to replace this trusted attestation with a real ZK verifier before submission; it is not represented as a ZK proof.
- 2026-09-11: Codex added RecoveryBundle persistence and integrity checks, then ran the local Anvil flow. Team review must confirm the offline checkpoint and storage assumptions.
- 2026-09-11: Codex resumed the interrupted failure-runner task. It implemented exact contract-error assertions, a valid-signature simulation, receipt-block refund accounting, bounded waits, cancellation and automatic local Anvil lifecycle in `src/failure-flow.mjs` and `scripts/run-failure-demo.mjs`; added `test/failure-flow.test.mjs`; and updated `package.json`, README and evidence records. A second Codex agent reviewed error classification, refund accounting and timeout handling. `npm test` passed 15 tests; `forge test -vv` passed 7 tests; the local failure flow passed 10 rejection checks and both refunds, including two runs on the same node without reset. See [the run record](../evidence/decisions/0010-failure-boundaries-run.md) for commands and source hashes. These are AI implementation and AI review; independent human reproduction, edits and acceptance remain pending.

## Encrypted recovery session

- 2026-09-12: User task brief: continue the next implementation step and resume after API interruptions. Codex implemented real HPKE envelope encryption, schema-2 signed recovery, independent-process decryption/re-evaluation, and a provider-abort prepayment-decryption/refund experiment. It also shared the automatic Anvil wrapper across both demos and added lifecycle regression tests.
- 2026-09-12: Codex fixed the omitted chain ID in the on-chain EIP-191 evidence domain, updated offline recovery and fixtures, added the Foundry chain-ID regression test, and regenerated both local reports. `forge test -vv` passed 8 tests and `npm test` passed 84 tests; both demos passed. See [decision 0012](../evidence/decisions/0012-chain-domain-separation.md). Human review and acceptance remain pending.
- 2026-09-12: Codex added the one-hour `VERIFICATION_GRACE` to the settlement contract, preventing immediate refund of a predeadline `Submitted` order during verifier processing and rejecting verification after the grace. It added Foundry tests for both boundaries, updated the failure flow and evidence ledger, and reran the demos. `forge test -vv` passed 10 tests and `npm test` passed 84 tests. See [decision 0013](../evidence/decisions/0013-submitted-verification-grace.md). Human contract review and acceptance remain pending.
- 2026-09-12: User-directed next step: Codex removed the buyer-only caller requirement from `settle`, kept the funded payee and amount immutable, added a relayer/buyer-offline Anvil trace, and added adversarial Foundry coverage for arbitrary callers, fixed-payee redirection, payout retry, reentrancy, duplicate settlement, and post-grace execution. `npm test` passed 84 tests; `forge test -vv` passed 24 tests; `npm run demo` and `npm run demo:failures` passed. See [decision 0014](../evidence/decisions/0014-verified-settlement-liveness.md). Human review and acceptance remain pending.
- 2026-09-12: User-directed next step: Codex implemented and tested a separate payment-gated disclosure candidate. The public bundle excludes its data key and is pinned by an external envelope commitment, so prepayment decryption fails; a mined post-settlement release succeeds; provider withholding after payment remains unrecoverable. `npm run experiment:payment-gated` passed on fresh Anvil and `npm test` passed 112 tests, including 28 focused cases. See [decision 0015](../evidence/decisions/0015-payment-gated-disclosure.md). The candidate is retained as a failure experiment, not claimed as fair exchange.
- AI-assisted files: `src/sealed-result.mjs`, `src/order.mjs`, `src/recovery.mjs`, `src/demo-flow.mjs`, `src/failure-flow.mjs`, `scripts/local-demo.mjs`, `scripts/run-demo.mjs`, `scripts/run-failure-demo.mjs`, `scripts/recover-demo.mjs`, `test/sealed-result.test.mjs`, `test/encrypted-recovery.test.mjs`, `test/local-demo.test.mjs`, `package.json`, README, execution/spec status and evidence records. Parallel Codex agents implemented the encryption helper, recovery validation and node wrapper; root integrated and ran the experiments. A separate agent reviewed the integration; its snapshot-ordering finding was fixed with shared canonical snapshot hashing and a regression test.
- Actual validation for the latest scope: 84 JavaScript tests and 24 Foundry tests passed; both CLI demos passed their assertions. The exchange counterexample remains a security failure, retained in the evidence rather than marked as a satisfied guarantee. Full commands, environment and machine-readable output are in [decision 0014](../evidence/decisions/0014-verified-settlement-liveness.md).
- Human contribution: no human code edit or acceptance was observed in this session. Substantial state-machine/replay/timeout work and adversarial contract tests remain assigned to a team member under `HUMAN_CONTRIBUTION.md`. These AI changes do not fulfill that ownership requirement.

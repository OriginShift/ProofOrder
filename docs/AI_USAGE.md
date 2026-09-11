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

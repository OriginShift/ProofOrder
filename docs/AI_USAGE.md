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

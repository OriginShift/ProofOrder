# ProofOrder Execution Plan

Updated: 2026-09-12 HKT. Submission target: 2026-09-14 00:00 HKT (ETHGlobal deadline is 2026-09-13 12:00 EDT).

Current gate: encrypted delivery, offline recovery and explicit chain domain separation work locally, but the HPKE exchange candidate fails full fair exchange. The [reproduced counterexample](../evidence/decisions/0011-encrypted-recovery-and-exchange-boundary.md) permits decryption before payment followed by timeout refund when the provider stops before on-chain verification. G1 is not accepted. The next mechanism decision must address that timing and the Verified-state exit before UI or sponsor expansion.

## First principle

The project advances only when a runnable experiment answers one of three questions: does a buyer need an external result, does hidden deterministic acceptance add a real guarantee over ordinary escrow, and can another developer reproduce both success and failure? Code volume is not progress.

## Competition objective

The team's priority order is:

1. Reach the ETHOnline 2026 Finalist judging round with a credible, reproducible submission.
2. Earn one or more naturally matched Partner Prizes with real integrations and evidence.
3. Pursue the overall championship through stronger technical proof, product clarity, reliability, and demo impact when the core path is stable.

Every scope decision is evaluated against this order. A feature that weakens the core demo, evidence quality, or deadline readiness does not enter the hackathon build merely because it sounds impressive.

## G0: freeze before broad implementation

- Freeze the allocation task, integer units, canonical encoding, score formula, threshold, deadline, and threat model.
- Write the exchange state machine and the offline checkpoint explicitly.
- Select the proof/encryption candidates by a time-boxed feasibility experiment. Do not call a mock verifier a result.
- Initial exchange candidate: encrypt for the buyer using HPKE and bind the complete envelope, order digest and evidence. The implemented direct HPKE envelope provides recipient encryption, but the complete package enables immediate buyer decryption. It does not satisfy payment-gated disclosure; the initial candidate failed the exchange experiment below.
- Go/no-go by the first working session: at least 20 successful HPKE round trips; deliberate ciphertext, wrapped-key, and order mutations must be rejected; Anvil escrow must cover submit, settle, duplicate, provider abort, and timeout refund. A public-mempool hash-locked reveal path is a documented failure experiment, not the default mechanism.
- Record the decision, rejected alternatives, assumptions, and command output in `evidence/decisions/`.

## G1: core mechanism

- Implement the fixed evaluator and negative cases first.
- Implement order/ciphertext/proof bindings and the smallest settlement contract.
- Run valid proof, changed ciphertext, changed order, changed rule, and secret-leakage experiments.
- Stop and narrow the claim if the leakage or exchange experiment fails.
- If a full ZK verifier cannot be benchmarked in the time box, ship the ECDSA-signed deterministic-evaluator adapter only as a clearly labeled trusted attestation. The signature authenticates the verifier's statement; it does not independently prove hidden computation or correct encryption. This fallback also requires explicit exchange limitations.

## G2: complete order

- Add independent buyer/provider processes and explicit agent tool calls.
- Persist the ciphertext before any settlement step.
- Implement status separation, idempotent retries, timeout exit, and recovery bundle import.
- Add the workbench only after the CLI path is reproducible.

## G3: release candidate

- Run the full acceptance ledger in `evidence/test-ledger.md` from a clean environment.
- Have a teammate who did not author each component reproduce it and review the threat model.
- Freeze architecture. Capture 2-4 minute, 720p+ human-narrated demo; never use AI voiceover.
- Submit as Finalist and Partner Prizes only after the dashboard, repository, video, and sponsor claims use identical capability wording.

## Four-day schedule

### Sep 9 night

G0 decision record, repository structure, task constants, interfaces, and proof/exchange feasibility spike.

### Sep 10

Evaluator, canonical bindings, encryption, proof circuit/verifier, and first local-chain settlement. Commit each coherent slice.

### Sep 11

Independent buyer/provider flow, persistence, recovery, failure paths, and attack scripts. Add only one naturally fitting sponsor integration after the core path works.

### Sep 12

Clean-room reproduction, measured evidence, UI polish, README, architecture/trust model, AI disclosure, and demo script.

### Sep 13

Buffer for fixes and recording. No new architecture. Upload and verify before the Hong Kong midnight deadline.

## Ownership and review

- Qy owns the shared spec, proof integration, buyer flow, and release candidate.
- Teammate A owns exchange timing, settlement contract, and adversarial review.
- Teammate B owns task adapter, provider flow, clean-room reproduction, README, and demo path.
- Authors do not sole-approve their own security-critical changes. Every gate needs a command, output, environment, and reviewer.

## Definition of done

The repository contains runnable code, tests, evidence, prompts/specs, source/asset attribution, and a demo path that proves the fixed capability with no background boolean standing in for verification or settlement.

# Human-Owned Work Items

The team uses Codex to accelerate implementation, but the following work must be completed and committed by a named team member after understanding the design. AI may explain, review, or suggest changes; it must not be the sole author or approver.

## Required human ownership

- Qy: freeze the task constants, canonical `OrderSpec` encoding, proof statement, and final buyer workflow. Qy must make the final edits to these files and explain the trade-offs in the decision record.
- Teammate A: personally implement or substantially edit the settlement state machine, timeout/refund transitions, replay protection, and adversarial contract tests. A must review every proof-to-payment boundary.
- Teammate B: personally implement or substantially edit the deterministic task evaluator and provider workflow, then reproduce the full flow from a clean environment. B must record whether the task is still a credible purchasing example.
- All three: run the acceptance ledger, inspect actual logs and balances, and sign off only on tests they understand. No author approves their own security-critical change alone.

## Chris implementation status

- 2026-09-12: Codex updated the evaluator validation path and boundary tests, centralized the order/snapshot schema checks, changed the provider adapter to bind evaluation and encryption to the order's committed snapshot, and updated the local demo and supporting records. See [decision 0016](../evidence/decisions/0016-teammate-b-provider-workflow.md). These are AI-assisted changes, not evidence of Teammate B's personal implementation. Teammate B must review and make substantive final edits, then record their name, actual edits, command results, reviewer and commit here.
- 2026-09-12: the user supplied logs for `npm test` (138 passed, 0 failed), `forge test -vv` (2 suites, 24 passed, 0 failed), and demo reports with `status: passed`. The raw logs and reports are linked from [decision 0016](../evidence/decisions/0016-teammate-b-provider-workflow.md). This records validation only; the named Teammate B's substantive edits and explanation, clean-environment reproduction, independent human review, and commit are still pending.
- 2026-09-12 follow-up: Chris applied Codex-proposed provider allocation snapshot/error handling and added the missing early return when evaluation rejects; the first run caught that omitted return. Post-fix logs show 9/9 focused provider tests, 139/139 JavaScript tests, and the main demo passed. Chris self-reviewed the two `provider-flow.mjs` changes and reported no issues. The changes were based on an AI-supplied proposal and are recorded as AI-assisted, not independent design; Chris's self-review does not satisfy the required independent human review. Teammate B must still record and explain their own substantive evaluator/provider decisions, obtain review from another teammate, reproduce from a clean environment, and commit.

## Evidence

Each human-owned slice should have a small commit with a clear message, a review comment or decision note, and a command result. The repository must preserve the prompts and AI-assisted files in `docs/AI_USAGE.md`, while also identifying the human decisions and edits that changed the result.

## Integrity rule

Do not create token human commits, mechanical retyping, or artificial authorship. If Codex generated a draft, the responsible member must inspect it, change what is necessary, test it, and be able to explain the code during judging. If a member cannot explain a security claim, that claim is removed or narrowed.

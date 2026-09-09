# Human-Owned Work Items

The team uses Codex to accelerate implementation, but the following work must be completed and committed by a named team member after understanding the design. AI may explain, review, or suggest changes; it must not be the sole author or approver.

## Required human ownership

- Qy: freeze the task constants, canonical `OrderSpec` encoding, proof statement, and final buyer workflow. Qy must make the final edits to these files and explain the trade-offs in the decision record.
- Teammate A: personally implement or substantially edit the settlement state machine, timeout/refund transitions, replay protection, and adversarial contract tests. A must review every proof-to-payment boundary.
- Teammate B: personally implement or substantially edit the deterministic task evaluator and provider workflow, then reproduce the full flow from a clean environment. B must record whether the task is still a credible purchasing example.
- All three: run the acceptance ledger, inspect actual logs and balances, and sign off only on tests they understand. No author approves their own security-critical change alone.

## Evidence

Each human-owned slice should have a small commit with a clear message, a review comment or decision note, and a command result. The repository must preserve the prompts and AI-assisted files in `docs/AI_USAGE.md`, while also identifying the human decisions and edits that changed the result.

## Integrity rule

Do not create token human commits, mechanical retyping, or artificial authorship. If Codex generated a draft, the responsible member must inspect it, change what is necessary, test it, and be able to explain the code during judging. If a member cannot explain a security claim, that claim is removed or narrowed.

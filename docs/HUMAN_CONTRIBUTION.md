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

## 2026-09-13 status: the new CLI/verifier slice is AI-authored and unapproved

The buyer/provider/verifier CLI workflow, the independent-verification module and the separate-process CLI harness in this worktree were written by an AI agent, not by a human owner. Nothing under this heading satisfies the personal implementation, explanation, review or acceptance requirement above. Status remains **pending** for:

- Qy (named future owner): final edits to the frozen `OrderSpec` encoding, proof statement and buyer workflow, with the trade-offs explained in a decision record.
- Every human-owned item listed above, including T20 and the clean-environment reproduction.

`DELIVERY_REPORT.md` records exactly which obligations were and were not met.

## 2026-09-13 WSL integration run (AI verification only)

- Codex applied the handoff implementation on Chris's branch and ran the final `bash scripts/reproduce.sh` in an Ubuntu WSL Linux-filesystem snapshot. It passed 196 JavaScript tests, 38 Foundry tests, the standalone 5-test CLI harness, and both local Anvil demos. The log is [0017-codex-wsl-reproduce.log](../evidence/runs/0017-codex-wsl-reproduce.log).
- This records Codex's test execution only. It does not count as Chris's personal implementation, human reproduction, independent security review, or Qy's final acceptance. WSL npm registry access failed through the configured proxy; Windows `npm ci --ignore-scripts` succeeded and Windows `npm audit` reported zero vulnerabilities on the same lockfile. WSL audit could not reach the advisory endpoint.
- The reviewed local reports show the settled payee received exactly the funded 1 ETH, escrow returned to zero, buyer nonce did not change after checkpoint, both failure-flow refunds returned funds to the buyer, and rejected simulations left state/balances/nonces unchanged. The fixture remains demonstration data, and the reports continue to show that fair exchange is not established.
- 2026-09-13 follow-up: Codex fixed `readSettlementStatus` so it always reads the RPC network's chain id, added a regression for actual chain 31337 versus expected 1 (`CHAIN_MISMATCH`), removed CLI wording that implied a plaintext result could be a successful verifier input, and made `scripts/reproduce.sh` fail when `npm audit` fails. The full WSL reproduction passed 197 JavaScript tests, 38 Foundry tests, the 5-test standalone CLI harness and both demos. WSL could not reach the Windows loopback-only npm proxy; a temporary wrapper checked the unchanged lockfile hash and passed through the exit status of a real Windows npm audit (0 vulnerabilities). Log: [0018-codex-wsl-reproduce.log](../evidence/runs/0018-codex-wsl-reproduce.log). This is Codex-authored and Codex-run work, not Chris's personal edit or independent human review; T20 remains pending.

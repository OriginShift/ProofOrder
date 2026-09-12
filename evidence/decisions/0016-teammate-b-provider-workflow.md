# Decision 0016: Teammate B provider workflow scope

Date: 2026-09-12 HKT

## Context

The fixed allocation task uses 10,000 integer units, a 6,000 per-target maximum, a 5,000 bps minimum liquidity threshold, and a 7,500 bps minimum weighted score. The current target list and metrics are local demonstration fixtures. The MVP excludes multi-chain support and real investment execution.

The provider adapter previously accepted the input snapshot and order digest as separate arguments. A caller could therefore evaluate against a snapshot that did not match the order's committed input while sealing the result under the supplied digest. Reusing the recovery schema also prevents the provider from attesting to a different task rule or snapshot shape than the buyer later accepts.

## Decision

Keep the frozen task rules and local Anvil flow. Do not add Sepolia data or redefine the liquidity metric in this Teammate B slice. The provider adapter must take the complete order, enforce the same fixed order and snapshot schema used by recovery, check that its snapshot matches `inputCommitment`, and derive the digest from that order before encrypting an accepted result. It must evaluate and seal one copied allocation value set so dynamic input properties cannot change the delivered result after evaluation.

The current fixture is not a credible real purchasing example. That claim would require real procurement inputs, documented eligibility rules, and an independently checkable basis for each metric. This slice demonstrates fixed-rule allocation evaluation and settlement only.

## Evidence and status

This record describes the intended scope and implementation. Codex made the initial code and test changes. Chris applied the AI-proposed allocation snapshot/error guard and then reported a missing early-return failure; after adding the evaluator rejection check, Chris supplied passing logs. Chris self-reviewed these two `provider-flow.mjs` changes and reported no issues; because Chris is the author, this is not the required independent human review. A second Codex agent performed a static review, which also does not count as human acceptance. The post-fix logs are archived as [provider tests](../runs/0016-provider-flow-after-fix.log) and [full JavaScript tests](../runs/0016-npm-test-after-fix.log). The latest main-flow report is [provider workflow demo after fix](../runs/0016-provider-workflow-demo-after-fix.json); it reports `status: passed` on local Anvil chain 31337. The earlier [failure-boundary demo report](../runs/0016-provider-workflow-failures.json) and [Foundry test log](../runs/0016-forge-test.log) remain evidence for the unchanged contract/failure-flow scope. Teammate B must still make and explain substantive evaluator/provider decisions, and another teammate must review the provider-to-order binding before this decision is accepted as human-owned work.

## Validation

On 2026-09-12, after Chris added the provider input-read guard and restored the early evaluator-rejection return, `node --test test/provider-flow.test.mjs` passed 9/9 and `npm test` passed 139/139. The post-fix logs are linked above. `npm run demo` also passed on a fresh local Anvil; its report is archived above and records 8 transactions. `forge test -vv` passed 24/24 across 2 suites before this JavaScript-only change; it was not rerun after the change, and no Solidity files changed. Chris self-reviewed the two provider changes and reported no issues; an independent teammate review is still pending. The failure-boundary demo passed earlier and its settlement/failure-flow code was not modified. The reports contain source SHA-256 values, inputs, transaction hashes, balances, and state transitions. No commit SHA was captured for these working-tree runs. Clean-install reproduction remains pending; these runs do not satisfy T20, and no acceptance-ledger row is fully accepted yet.

# Acceptance Evidence Ledger

Status: partial local implementation evidence; no gate is fully accepted. Passed entries describe only the tested scope. Independent human review is pending.

| ID | Scenario | Expected evidence | Status |
| --- | --- | --- | --- |
| T01 | Valid result | proof, balances, recovery and re-evaluation | [Local encrypted delivery, signed attestation, exact fixed-payee payout and independent offline recovery](runs/0016-provider-workflow-demo-after-fix.json) passed; ZK/fair exchange pending |
| T02 | Rule violation | verifier/settlement rejection | Evaluator rejection and provider no-encryption cases passed ([focused provider tests](runs/0016-provider-flow-after-fix.log), [full JavaScript tests](runs/0016-npm-test-after-fix.log)); invalid signature/evidence and settle-before-verification rejection passed ([Foundry log](runs/0016-forge-test.log)); independent review pending |
| T03 | Empty/duplicate/negative/out-of-range result | stable evaluator error code | 139 JavaScript tests passed, including negative/fractional/string/unsafe-integer inputs and exact/below-floor thresholds ([npm test log](runs/0016-npm-test-after-fix.log)); independent review pending |
| T04 | Changed input snapshot | binding failure | schema-2 recovery rejects snapshot/commitment mutation and plaintext-supplied snapshots; on-chain independent evaluation pending |
| T05 | Changed rule or verifier version | binding failure | evidence digest changes; on-chain ECDSA binding passed; ZK verifier pending |
| T06 | Replaced ciphertext | delivery binding failure | [HPKE envelope, signature and recovery mutation checks](decisions/0011-encrypted-recovery-and-exchange-boundary.md) and local chain commitment rejection passed; ZK pending |
| T07 | Replaced order | replay/binding failure | HPKE AAD, local chain binding and schema-2 recovery order/digest checks passed; ZK pending |
| T08 | Replaced payee | fixed-recipient failure | permissionless caller and fuzz tests cannot redirect the immutable payee; external payee acceptance remains an operational dependency ([run 0014](runs/0014-verified-settlement.json)) |
| T09 | Cross-domain replay | domain separation failure | contract evidence hash now binds `block.chainid`; Foundry hash-difference test and offline chain-context checks passed ([decision 0012](decisions/0012-chain-domain-separation.md)); public testnet replay pending |
| T10 | Duplicate submit/settle | idempotent rejection | contract path passed; permissionless duplicate and reentrancy paths passed ([run 0014](runs/0014-verified-settlement.json)) |
| T12 | Provider abort | bounded exit/refund | Funded and Submitted timeout refunds pass with event/balance assertions; Submitted refund uses a 1-hour verifier grace; a Verified order can be settled by provider/relayer after buyer stops; provider-initiated pre-verification exit remains pending ([run 0016](runs/0016-provider-workflow-failures.json)) |
| T13 | Missing or corrupt ciphertext | no false recovery success | schema-2 envelope/signature/key mutation checks and durable local recovery passed; external storage pending |
| T15 | Failed transaction leaks secret | mechanism result and narrowed claim if needed | [Prepayment decryption followed by provider-abort refund reproduced](decisions/0011-encrypted-recovery-and-exchange-boundary.md); [payment-gated candidate blocks prepayment but permits provider withholding after payment](decisions/0015-payment-gated-disclosure.md); full fair exchange failed and claim narrowed |
| T16 | Deadline race | legal/illegal state traces | [Local predeadline refund rejection, Submitted verifier grace and post-grace refund/verify checks](decisions/0010-failure-boundaries-run.md) passed; exact-deadline transaction races pending |
| T17 | Unconfirmed/reorged transaction | no premature final status | pending |
| T18 | Retry/network interruption | same order, no duplicate payment | contract idempotency path tested; CLI retry pending |
| T20 | Clean environment | independent reproduction log | Codex reran the full WSL reproduction successfully ([0018 log](runs/0018-codex-wsl-reproduce.log): 197 JavaScript tests, 38 Foundry tests, standalone CLI harness and both demos); WSL clean install is still blocked by registry access, and independent human reproduction remains pending |
| T21 | RPC chain mismatch | refuse a status read from the wrong network | Mock RPC reports chain 31337 while the order expects 1; `readSettlementStatus` reads `getNetwork()` and returns `CHAIN_MISMATCH` ([test](../test/settlement-status.test.mjs), [full run](runs/0018-codex-wsl-reproduce.log)); independent review pending |

Each completed row must link to the exact command, source revision, inputs, proof/public inputs, logs, transaction IDs or local-chain trace, balances, timing, and reviewer.

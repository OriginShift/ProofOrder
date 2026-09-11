# Acceptance Evidence Ledger

Status: partial local implementation evidence; no gate is fully accepted. Passed entries describe only the tested scope. Independent human review is pending.

| ID | Scenario | Expected evidence | Status |
| --- | --- | --- | --- |
| T01 | Valid result | proof, balances, recovery and re-evaluation | local Anvil settlement + ECDSA evidence path passed; recovery integration pending |
| T02 | Rule violation | verifier/settlement rejection | evaluator rejection cases passed; verifier/settlement pending |
| T03 | Empty/duplicate/negative/out-of-range result | stable evaluator error code | empty/duplicate/concentration/liquidity cases passed; negative/encoding cases pending |
| T04 | Changed input snapshot | binding failure | pending |
| T05 | Changed rule or verifier version | binding failure | evidence digest changes; on-chain ECDSA binding passed; ZK verifier pending |
| T06 | Replaced ciphertext | delivery binding failure | HPKE primitive and [local commitment-mismatch rejection](decisions/0010-failure-boundaries-run.md) passed; integrated encryption/ZK pending |
| T07 | Replaced order | replay/binding failure | HPKE AAD and [local order-digest mismatch rejection](decisions/0010-failure-boundaries-run.md) passed; ZK/recovery pending |
| T08 | Replaced payee | fixed-recipient failure | pending |
| T09 | Cross-domain replay | domain separation failure | pending |
| T10 | Duplicate submit/settle | idempotent rejection | contract path passed; demo flow passed |
| T12 | Provider abort | bounded exit/refund | [Local Funded and Submitted timeout refunds](decisions/0010-failure-boundaries-run.md) passed with event/balance assertions; provider-initiated exit and Verified-state handling pending |
| T13 | Missing or corrupt ciphertext | no false recovery success | RecoveryBundle mutation test passed; provider/storage integration pending |
| T15 | Failed transaction leaks secret | mechanism result and narrowed claim if needed | pending |
| T16 | Deadline race | legal/illegal state traces | [Local predeadline refund rejection and postdeadline refund/submit checks](decisions/0010-failure-boundaries-run.md) passed; exact-deadline ordering and transaction races pending |
| T17 | Unconfirmed/reorged transaction | no premature final status | pending |
| T18 | Retry/network interruption | same order, no duplicate payment | contract idempotency path tested; CLI retry pending |
| T20 | Clean environment | independent reproduction log | automated fresh-Anvil run passed; clean installation and independent human reproduction pending |

Each completed row must link to the exact command, source revision, inputs, proof/public inputs, logs, transaction IDs or local-chain trace, balances, timing, and reviewer.

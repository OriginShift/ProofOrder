# Acceptance Evidence Ledger

Status: partial local implementation evidence; no gate is fully accepted. Passed entries describe only the tested scope. Independent human review is pending.

| ID | Scenario | Expected evidence | Status |
| --- | --- | --- | --- |
| T01 | Valid result | proof, balances, recovery and re-evaluation | [Local encrypted delivery, signed attestation, exact payout and independent offline recovery](decisions/0011-encrypted-recovery-and-exchange-boundary.md) passed; ZK/fair exchange pending |
| T02 | Rule violation | verifier/settlement rejection | evaluator rejection cases passed; verifier/settlement pending |
| T03 | Empty/duplicate/negative/out-of-range result | stable evaluator error code | empty/duplicate/concentration/liquidity cases passed; negative/encoding cases pending |
| T04 | Changed input snapshot | binding failure | schema-2 recovery rejects snapshot/commitment mutation and plaintext-supplied snapshots; on-chain independent evaluation pending |
| T05 | Changed rule or verifier version | binding failure | evidence digest changes; on-chain ECDSA binding passed; ZK verifier pending |
| T06 | Replaced ciphertext | delivery binding failure | [HPKE envelope, signature and recovery mutation checks](decisions/0011-encrypted-recovery-and-exchange-boundary.md) and local chain commitment rejection passed; ZK pending |
| T07 | Replaced order | replay/binding failure | HPKE AAD, local chain binding and schema-2 recovery order/digest checks passed; ZK pending |
| T08 | Replaced payee | fixed-recipient failure | pending |
| T09 | Cross-domain replay | domain separation failure | offline recovery checks trusted chain/contract/verifier context; contract message still lacks explicit chain ID, on-chain replay test pending |
| T10 | Duplicate submit/settle | idempotent rejection | contract path passed; demo flow passed |
| T12 | Provider abort | bounded exit/refund | [Local Funded and Submitted timeout refunds](decisions/0010-failure-boundaries-run.md) passed with event/balance assertions; provider-initiated exit and Verified-state handling pending |
| T13 | Missing or corrupt ciphertext | no false recovery success | schema-2 envelope/signature/key mutation checks and durable local recovery passed; external storage pending |
| T15 | Failed transaction leaks secret | mechanism result and narrowed claim if needed | [Prepayment decryption followed by provider-abort refund reproduced](decisions/0011-encrypted-recovery-and-exchange-boundary.md): full fair exchange failed, claim narrowed; failed/reverted-transaction and mempool race traces pending |
| T16 | Deadline race | legal/illegal state traces | [Local predeadline refund rejection and postdeadline refund/submit checks](decisions/0010-failure-boundaries-run.md) passed; exact-deadline ordering and transaction races pending |
| T17 | Unconfirmed/reorged transaction | no premature final status | pending |
| T18 | Retry/network interruption | same order, no duplicate payment | contract idempotency path tested; CLI retry pending |
| T20 | Clean environment | independent reproduction log | automated fresh-Anvil run passed; clean installation and independent human reproduction pending |

Each completed row must link to the exact command, source revision, inputs, proof/public inputs, logs, transaction IDs or local-chain trace, balances, timing, and reviewer.

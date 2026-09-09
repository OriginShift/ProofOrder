# Acceptance Evidence Ledger

Status: all entries pending implementation and execution.

| ID | Scenario | Expected evidence | Status |
| --- | --- | --- | --- |
| T01 | Valid result | proof, balances, recovery and re-evaluation | pending (HPKE recovery primitive passed; proof/chain pending) |
| T02 | Rule violation | verifier/settlement rejection | evaluator rejection cases passed; verifier/settlement pending |
| T03 | Empty/duplicate/negative/out-of-range result | stable evaluator error code | empty/duplicate/concentration/liquidity cases passed; negative/encoding cases pending |
| T04 | Changed input snapshot | binding failure | pending |
| T05 | Changed rule or verifier version | binding failure | pending |
| T06 | Replaced ciphertext | delivery binding failure | HPKE primitive passed; proof/chain pending |
| T07 | Replaced order | replay/binding failure | HPKE AAD binding passed; proof/chain pending |
| T08 | Replaced payee | fixed-recipient failure | pending |
| T09 | Cross-domain replay | domain separation failure | pending |
| T10 | Duplicate submit/settle | idempotent rejection | pending (contract not implemented) |
| T12 | Provider abort | bounded exit/refund | pending |
| T13 | Missing or corrupt ciphertext | no false recovery success | pending |
| T15 | Failed transaction leaks secret | mechanism result and narrowed claim if needed | pending |
| T16 | Deadline race | legal/illegal state traces | pending |
| T17 | Unconfirmed/reorged transaction | no premature final status | pending |
| T18 | Retry/network interruption | same order, no duplicate payment | pending |
| T20 | Clean environment | independent reproduction log | pending |

Each completed row must link to the exact command, source revision, inputs, proof/public inputs, logs, transaction IDs or local-chain trace, balances, timing, and reviewer.

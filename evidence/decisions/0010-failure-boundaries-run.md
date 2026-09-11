# Failure Boundaries Run

Date: 2026-09-11 HKT
Command: `npm run demo:failures`
Environment: Anvil 1.6.0, Node v25.9.0, ethers 6.15.0, solc 0.8.24, chain 31337
Executor and implementation: Codex. Review: separate Codex agent; independent human acceptance pending.

The [machine-readable run](../runs/0010-failure-boundaries.json) records the inputs, deployed contract, actor addresses, signatures, source SHA-256 hashes, block hashes, mined transaction hashes and receipt-block balances. It identifies the exact sources used without depending on a commit hash that does not yet exist when the command runs. A new invocation writes a new ignored report to `artifacts/failure-boundaries.json`.

## Result

- A valid verifier signature succeeded in a simulation, establishing that the fixture can pass verification.
- Ten rejection simulations returned their exact ABI errors. Full order records, actor/escrow balances and pending nonces were unchanged after each simulation.
- A funded order with no submission and a submitted order with no accepted verification each held 1 ETH. After advancing to one second beyond the later deadline, both refunds were mined and both orders ended in `Refunded` (enum value 5).
- Escrow balances were 2 ETH before the first refund, 1 ETH after the first refund, and 0 ETH after the second. Each `Refunded` event matched its order, buyer and recorded amount. Each buyer balance increase plus its receipt fee was exactly 1 ETH; the provider/payee balance was unchanged.

| Rejection scenario | Exact error |
| --- | --- |
| Wrong verifier signature | `InvalidSignature` |
| Changed order digest | `InvalidOrder` |
| Changed ciphertext commitment | `InvalidOrder` |
| Changed evidence digest with original signature | `InvalidSignature` |
| Settlement before verification | `InvalidState` |
| Submitted-order refund before deadline | `DeadlineNotReached` |
| Funded-order refund before deadline | `DeadlineNotReached` |
| Provider submission after deadline | `DeadlinePassed` |
| Repeated funded-order refund | `InvalidState` |
| Repeated submitted-order refund | `InvalidState` |

## Reproduction and regression checks

1. Install locked npm dependencies and initialize the Foundry submodule as described in README.
2. Run `npm test`: 15 tests passed, including rejection of RPC/unknown errors as evidence and bounded failure/cancellation of an unresponsive RPC.
3. Run `forge test -vv`: 7 contract tests passed. Existing timestamp lint warnings remain; this run does not resolve deadline races.
4. Run `npm run demo:failures`: the command builds the contract, starts a fresh loopback Anvil, runs all assertions, writes the report, and stops its node.

An additional CLI check, `PROOFORDER_RPC_URL=http://127.0.0.1:1 node scripts/run-failure-demo.mjs`, exited with code 1 and `ECONNREFUSED`. The prior success report was absent afterward. The fresh-node command was then rerun to produce the committed JSON above.

Additional repeated-node check used an already-running dedicated Anvil on port 8551, with no reset between runs:

```bash
node --input-type=module -e 'import assert from "node:assert/strict"; import { runFailureFlow } from "./src/failure-flow.mjs"; const first = await runFailureFlow("http://127.0.0.1:8551"); const second = await runFailureFlow("http://127.0.0.1:8551"); assert.notEqual(first.settlementAddress, second.settlementAddress); assert.ok(BigInt(second.inputs.submittedDeadline) > BigInt(first.inputs.submittedDeadline)); console.log(JSON.stringify({ scenario: "repeat-without-node-reset", runs: [first, second].map(r => ({ status: r.status, settlement: r.settlementAddress, deadline: r.inputs.submittedDeadline, rejectedCalls: r.rejectedCalls.length, finalEscrowBalanceWei: r.finalEscrowBalanceWei })) }, null, 2));'
```

Both runs passed 10 rejection checks and ended at zero escrow. The deployed contracts were `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` and `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318`; their submitted-order deadlines were `1789147346` and `1789150947`. This checks fresh deployment after earlier time travel, not resumption of an interrupted order.

## Implementation decisions

Expected failures use `eth_call` and require `CALL_EXCEPTION` with the decoded expected custom error. Signing and RPC failures cannot count as contract rejection. Unlocked local signers avoid a client-side nonce increment during failed transaction preparation. Provider caching is disabled, deadlines come from chain time, and refund balances use explicit receipt block numbers.

The runner bounds HTTP requests to 5 seconds, receipt waits to 15 seconds and the full flow to 60 seconds, including transaction submission. Interruptions destroy the RPC provider and clean up only the Anvil process owned by the command. An ambiguous transaction failure exits nonzero; it is not automatically retried.

## Boundary

These are local Anvil traces. Rejections and the positive control are simulations; funding, submission and refund operations are mined transactions. Commitments represent placeholder bytes, not integrated encrypted results. There is no ZK verification, public testnet finality, reorg, exact-deadline race, secret-leakage, recovery decryption or interrupted-order retry evidence here.

The current contract permits verification after the deadline and prevents refund once an order is `Verified`. These traces cover only `Funded` and `Submitted` refund paths; they do not establish a bounded exit for every state or full fair exchange. G1/G2 and the acceptance ledger remain incomplete.

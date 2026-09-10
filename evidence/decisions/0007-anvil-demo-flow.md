# Local Anvil Demo Flow

Date: 2026-09-11 HKT
Command: `PROOFORDER_RPC_URL=http://127.0.0.1:8546 npm run demo`
Environment: Anvil 1.6.0, Node v25.9.0, Foundry solc 0.8.24

## Observed result

- Buyer funded the order, provider submitted the ciphertext commitment, verifier approved matching evidence, and buyer settled.
- Final contract state: `Settled` (enum value 4).
- Settlement contract balance: `0` wei after payout.
- Provider balance increased by `999932708169658624` wei, after provider transaction gas.
- The script printed the order ID, order digest, ciphertext commitment, evidence digest, and evaluator score (`7960` bps).

## Reproduction

Start a local node with `anvil --port 8546`, then run the command above. The script uses only the documented default Anvil development keys and deploys a fresh contract each run.

## Claim boundary

This is a local-chain flow using deterministic evaluator evidence. It is not a public testnet deployment, a signature verifier, or a zero-knowledge proof. The verifier trust boundary remains explicit.

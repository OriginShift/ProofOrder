# Recovery Bundle Demo

Date: 2026-09-11 HKT
Commands: `npm test`, `PROOFORDER_RPC_URL=http://127.0.0.1:8546 npm run demo`

## Result

- Node tests: 11/11 passed, including valid bundle validation, ciphertext mutation rejection, and order-evidence mismatch rejection.
- The Anvil demo saved `artifacts/demo-recovery-bundle.json` before settlement and loaded it after settlement.
- Bundle validation returned `valid: true` and recovered 306 bytes of ciphertext metadata.
- The same demo reached contract state `Settled` and left the settlement contract at `0` wei.

## Boundary

Recovery depends on the buyer retaining the local bundle, private key, and retrievable chain state. It does not promise recovery after local deletion or unavailable external storage.

# G1 Settlement State Machine Run

Date: 2026-09-10 HKT
Command: `forge test -vv`
Environment: Foundry 1.6.0, solc 0.8.24, forge-std v1.16.2

## Result

Five tests passed:

- funded -> submitted -> verified -> settled pays the fixed payee;
- settlement before verification is rejected;
- duplicate submission and duplicate settlement are rejected;
- timeout refund returns funds to the buyer;
- provider cannot act as the verifier.

Measured gas in the local tests ranged from 170,773 to 244,594 for the exercised paths.

The contract accepts verification only from an explicit verifier address. The verifier implementation and cryptographic proof check are still pending; this contract is not evidence that a proof was valid by itself. The test chain is local Anvil/Foundry state, not a public testnet receipt.

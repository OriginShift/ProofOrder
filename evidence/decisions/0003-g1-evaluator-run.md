# G1 Evaluator and Order Encoding Spike

Date: 2026-09-10 HKT
Command: `npm test`
Environment: Node v25.9.0

## Frozen demo rule

- Budget: 10,000 integer units.
- Maximum allocation to one target: 6,000 units.
- Minimum target liquidity: 5,000 bps.
- Minimum weighted score: 7,500 bps.
- Input snapshot: fixed target IDs, liquidity values, and score values.

## Result

Seven tests passed: valid allocation, empty result, concentration/budget rejection, duplicate target, unauthorized target, liquidity floor, and canonical order digest stability. The digest is independent of JSON object insertion order and changes when the order nonce changes.

This is a deterministic evaluator and binding primitive, not a proof system or chain settlement. A teammate must review the rule constants and independently rerun the command before this evidence is treated as a release gate.

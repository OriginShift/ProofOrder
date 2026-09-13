# ProofOrder — bounded delivery report (2026-09-13)

Branch: `feat/chris-workflow-completion`, based on `OriginShift/ProofOrder` `main` at `1c6ffdebdd4358086f38db19cb191bec5b816516`.
The implementation in this slice was produced with AI assistance. This report records the Codex-run reproduction on the branch snapshot; it is not a human acceptance record.

## Parent correction

Plaintext-only verification is refused with `UNBOUND_PLAINTEXT_REFUSED`: re-evaluating an unrelated plaintext cannot establish the ciphertext contents. Use the authenticated decryption path only. Final parent rerun and packaging details are in `FINAL_REVIEW_ZH.md`; earlier logs are historical checkpoints, not substitutes for the final rerun.

## 1. Verified results (Codex-run reproduction)

The latest full script ran in Ubuntu WSL on a fresh Linux-filesystem copy of this branch snapshot. Runtime: Node v26.5.1, npm 11.17.0 and Foundry v1.8.1; Anvil used chain ID 31337 and loopback only. WSL's npm registry access remains blocked by its proxy, so the already installed Windows `node_modules` was copied into the Linux snapshot. The WSL audit endpoint was also unreachable; an actual Windows npm 10.9.3 audit was run on the same `package-lock.json`. A temporary, uncommitted wrapper checked the lockfile SHA-256 (`0dbc5e7d5bf3b2c013c12b4b856f9cd07f787f48511ddcfb6313d26657b9f012`) and propagated that audit's exit status at the script's audit step. The log records this adaptation. `scripts/reproduce.sh` itself now runs `npm audit` directly, so a nonzero audit exits the script.

| Check | Command | Result |
| --- | --- | --- |
| Full reproduction | `bash scripts/reproduce.sh` | **exit 0**, log [0018-codex-wsl-reproduce.log](evidence/runs/0018-codex-wsl-reproduce.log) |
| JS unit + CLI end-to-end | `npm test` | **197 tests, 197 pass, 0 fail** (baseline was 179) |
| Contract tests | `forge test -vv` | **38 tests, 0 failed, 3 suites** (baseline 24 + 14 adversarial) |
| CLI end-to-end alone | `node --test test/cli-workflow.test.mjs` | **5 tests, 5 pass, 0 fail** (already included in `npm test`) |
| Encrypted delivery demo | `npm run demo` | `status: passed` (`artifacts/encrypted-delivery.json`) |
| Failure boundaries demo | `npm run demo:failures` | `status: passed` (`artifacts/failure-boundaries.json`) |
| Dependency audit | Windows npm 10.9.3 `npm audit`, checked by the WSL reproduction wrapper | **0 vulnerabilities**; lockfile SHA-256 matched the WSL snapshot |

The inspected delivery report ended `Settled`; the payee received exactly 1 ETH, escrow reached zero, and the buyer's nonce stayed at 2 after its checkpoint with zero buyer transactions after that checkpoint. The failure report showed both refund transactions ending in `Refunded`, total escrow zero, payee balance unchanged by refunds, and state/balance/nonce unchanged for simulated rejected calls. The exchange counterexample still reproduced: the buyer could decrypt before payment and later obtain a refund, so `fairExchangeEstablished` is false.

The CLI end-to-end harness runs each participant as a **separate OS process** against a fresh Anvil on
its own free port (never the shared 8545), and rejects on any refused step.

### Exact rerun commands

```bash
bash scripts/reproduce.sh          # everything above, one log in delivery-logs/
npm test                           # JS units + separate-process CLI harness
forge test -vv                     # 24 baseline + 14 adversarial tests
npm run test:cli                   # CLI E2E only (own fresh Anvil, free port)
```

Earlier handoff reference run (not the WSL reproduction recorded above; use any free port):

```bash
export PATH="$HOME/.foundry/bin:$PATH"
anvil --host 127.0.0.1 --port 8599 --chain-id 31337 &
RPC=http://127.0.0.1:8599; D=$(mktemp -d)
node scripts/buyer-cli.mjs    init   --rpc $RPC --dir $D
node scripts/buyer-cli.mjs    fund   --rpc $RPC --dir $D
node scripts/provider-cli.mjs submit --rpc $RPC --dir $D
node scripts/verifier-cli.mjs attest --rpc $RPC --dir $D --verification-key-file $D/recipient-key.json
node scripts/buyer-cli.mjs    verify  --dir $D
node scripts/buyer-cli.mjs    release --rpc $RPC --dir $D
node scripts/buyer-cli.mjs    recover --dir $D
```

Observed on that run: `publishedOnChain: true`, `verificationPath: "independent-decrypt-and-reevaluate"`,
`scoreBps: 7960`, `payeeCreditWei: "1000000000000000000"`, `deliveryObserved: false`,
`settlementStatus: "not-queried"`.

## 2. Priority security fixes (all with red/green tests)

1. **The verifier no longer signs the provider's claim.** New `src/verifier-flow.mjs`; `scripts/verifier-cli.mjs`
   now requires `--verification-key-file` for the demo recipient HPKE key. Parent review found
   the plaintext-only path unbound to ciphertext and disabled it with a red/green regression test. It re-runs the frozen
   rule (`evaluateAllocation`) over the recovered allocations, recomputes the evidence digest, compares it with
   the provider's evidence, and confirms the on-chain `Submitted` binding (order id, ciphertext commitment,
   funded buyer/provider/payee/amount/deadline, evidence digest). It refuses with
   `MISSING_VERIFICATION_INPUT`, `EVALUATION_MISMATCH`, `EVIDENCE_MISMATCH`, `CIPHERTEXT_COMMITMENT_MISMATCH`,
   `NOT_SUBMITTED`, `CHAIN_CIPHERTEXT_MISMATCH`, `CHAIN_ORDER_MISMATCH` … instead of signing.
   Every success carries a disclosure: **the verifier holds decryption capability in this trusted local demo —
   that is not private isolation**, and the attestation is a trusted ECDSA attestation, not a proof of hidden
   computation. `--publish` (default) mines `markVerified` so a release can follow; `--no-publish` signs only.
2. **Timeout refund no longer needs a provider bundle.** New `buyer-cli refund --rpc --dir` uses the durable
   checkpoint and chain state only (`bundleRequired: false`, `bundleRead: false`). `release` refuses the refund
   path with `REFUND_REQUIRED` and names the command.
3. **Provider submission is bound and non-destructive.** `provider-cli submit` re-derives the order id/digest
   from the order bytes, compares the funded on-chain order terms *before writing or sending*, is idempotent on
   repeat (no rewrite, no transaction, verified in the harness by byte-comparing the persisted file), and refuses
   with `ALREADY_SUBMITTED` / `SUBMISSION_CONFLICT` rather than overwriting a delivered ciphertext (HPKE
   encapsulation is randomised, so a re-seal can never reproduce the first ciphertext).
4. **`buyer-cli init` refuses an existing workflow** (`EXISTING_STATE`) before deploying or writing anything, so
   it cannot overwrite a key, checkpoint or order.
5. **Status never turns verification into settlement or delivery**: `delivery.observed` is always false;
   an unfunded order is reported as an observation (`ORDER_NOT_FOUND`, next action `fund`), not as a failed read.

### Bugs found and fixed while running the checks

- Forge's output directory in this environment is `artifacts/`, not `out/`; the shared resolver
  (`src/chain-client.mjs`) now tries both and validates `abi`/`bytecode{,.object}`. The three flow modules that
  hard-coded `out/` are fixed — this is why both demos were failing before.
- `sha256:` vs `bytes32` digest mapping at the status-read boundary (buyer `status`/`release` would always have
  failed with `ORDER_DIGEST_MISMATCH`), and the recovery-bundle commitment form in the `markVerified` call.
- `readSettlementStatus` used to substitute `expectedChainId` for the RPC's actual network id; it now always
  reads `provider.getNetwork()`. The regression test reports `CHAIN_MISMATCH` for actual chain 31337 when 1 is
  expected. `scripts/reproduce.sh` no longer turns a failing `npm audit` into a successful run.

## 3. Tests added

- `test/verifier-flow.test.mjs` (12): decrypt path, plaintext-only refusal, self-consistent-but-wrong claim
  rejected (`EVALUATION_MISMATCH`), replaced ciphertext, missing input, rule-failing result, chain ciphertext /
  not-submitted / terms / order-id mismatches, tampered order, already-verified.
- `test/cli-workflow.test.mjs` (5, separate-process, own Anvil): full happy path; timeout refund with no bundle;
  tampered claim (verifier signs nothing, chain state unchanged); tampered recovery bundle rejected by the buyer;
  provider refusal on digest mismatch and on an unfunded order (nothing written).
- `test/ProofOrderAdversarial.t.sol` (14, contract unchanged — behaviour only pinned): cross-order and
  cross-contract signature replay, evidence-hash domain separation, provider-only submit, permissionless
  `markVerified`/`settle` with a fixed payee, zero commitment / zero evidence / malformed signature lengths,
  exact grace and deadline boundaries, provider refund after grace paying the buyer, one-shot funding and zero-term
  rejections, stranger settlement cannot redirect the payee.

## 4. Not done, blocked, or explicitly not claimed

- **No human acceptance is complete.** The implementation and this reproduction were AI-assisted/AI-run; they do
  not satisfy personal implementation or independent review. **T20 and the required human review remain pending**,
  as do the outstanding items in `docs/HUMAN_CONTRIBUTION.md`. This work is recorded as AI-authored in
  `docs/AI_USAGE.md`; prior contributors' records are preserved.
- **Qy remains the named future owner** of the frozen `OrderSpec` encoding, the proof statement and the final
  buyer workflow, and still needs to make those edits and explain the trade-offs.
- **Trust boundary unchanged:** the verifier can decrypt in this local demo (disclosed in every result). The
  attestation does not prove hidden computation, delivery, or fair exchange. Decision 0015's provider-withholding
  counterexample stands; the payment-gated experiment remains a failed candidate and is not wired into settlement.
- The settlement contract was **not** modified; `SettlementStatus` still cannot observe delivery. No public
  testnet, multi-order, marketplace or real-procurement claim is made, and the fixture is demo data only.
The committed reproduction record contains no private-key material. It includes public local-chain addresses, test signatures and transaction data needed to review the result. Human review and Qy's final acceptance remain open.

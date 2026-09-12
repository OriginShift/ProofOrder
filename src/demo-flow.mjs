import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ContractFactory, FetchRequest, JsonRpcProvider, ZeroHash, getBytes, keccak256, parseEther, version } from "ethers";
import { buildEvidence } from "./evidence.mjs";
import { evaluateAllocation } from "./evaluator.mjs";
import { canonicalOrder, orderDigest, snapshotCommitment } from "./order.mjs";
import { createEncryptedRecoveryBundle, loadRecoveryBundle, recoverEncryptedResult, saveRecoveryBundle, verifyEncryptedRecoveryBundle } from "./recovery.mjs";
import { generateRecipientKeyPair, openSealedResult, sealResult, sealedResultCommitment } from "./sealed-result.mjs";

const execFileAsync = promisify(execFile);
const hexDigest = (value) => `0x${value.slice("sha256:".length)}`;
const snapshot = {
  id: "fixed-snapshot-001",
  targets: [
    { id: "target-a", liquidityBps: 9000, scoreBps: 8200 },
    { id: "target-b", liquidityBps: 8000, scoreBps: 7600 },
  ],
};
const result = { allocations: [{ target: "target-a", amountMinorUnits: 6000 }, { target: "target-b", amountMinorUnits: 4000 }] };

export async function runDemoFlow(rpcUrl, { signal, timeoutMs = 60_000 } = {}) {
  const url = new URL(rpcUrl);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Demo requires local Anvil HTTP");
  const request = new FetchRequest(url.href);
  request.timeout = 5_000;
  const rpc = new JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  rpc.pollingInterval = 100;
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

  async function execute() {
    const clientVersion = await rpc.send("web3_clientVersion", []);
    assert.match(clientVersion, /anvil/i);
    assert.equal(BigInt(await rpc.send("eth_chainId", [])), 31337n);
    const buyer = await rpc.getSigner(0);
    const provider = await rpc.getSigner(1);
    const verifier = await rpc.getSigner(2);
    const relayer = await rpc.getSigner(3);
    const buyerAddress = await buyer.getAddress();
    const providerAddress = await provider.getAddress();
    const verifierAddress = await verifier.getAddress();
    const relayerAddress = await relayer.getAddress();
    assert.equal(new Set([buyerAddress, providerAddress, verifierAddress, relayerAddress]).size, 4);
    const artifact = JSON.parse(await readFile(new URL("../out/ProofOrderSettlement.sol/ProofOrderSettlement.json", import.meta.url), "utf8"));
    const transactions = [];
    const mined = async (pending, action) => {
      combinedSignal.throwIfAborted();
      const receipt = await (await pending).wait(1, 15_000);
      assert.equal(receipt?.status, 1, `${action} failed`);
      transactions.push({ action, from: receipt.from, hash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
      return receipt;
    };
    const settlement = await new ContractFactory(artifact.abi, artifact.bytecode, buyer).deploy(verifierAddress);
    await mined(settlement.deploymentTransaction(), "deploy");
    const contractAddress = await settlement.getAddress();
    const amount = parseEther("1");
    const verificationGrace = Number(await settlement.VERIFICATION_GRACE());
    const latest = () => rpc.send("eth_getBlockByNumber", ["latest", false]);
    const artifacts = fileURLToPath(new URL("../artifacts/", import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(`${artifacts}encrypted-`);

    async function prepare(label) {
      combinedSignal.throwIfAborted();
      const recipient = await generateRecipientKeyPair();
      const deadline = Number(BigInt((await latest()).timestamp)) + 900;
      const order = JSON.parse(canonicalOrder({
        nonce: `0x${randomBytes(32).toString("hex")}`, chainId: 31337, settlementContract: contractAddress,
        buyer: buyerAddress, provider: providerAddress, payee: providerAddress,
        verifierVersion: "ecdsa-evaluator-v1", verifierAddress, paymentAsset: "native", feeMinorUnits: String(amount),
        deadline, deadlineSeconds: 900, snapshot, inputCommitment: snapshotCommitment(snapshot),
        recipientPublicKey: recipient.publicKey,
      }));
      const digest = `sha256:${Buffer.from(await orderDigest(order)).toString("hex")}`;
      const orderId = keccak256(Buffer.from(`ProofOrder/demo/v2|${digest}`));
      const plaintext = Buffer.from(JSON.stringify(result));
      const evaluation = evaluateAllocation({ snapshot: order.snapshot, allocations: result.allocations });
      assert.equal(evaluation.ok, true);
      const sealedResult = await sealResult({ plaintext, recipientPublicKey: recipient.publicKey, orderDigest: hexDigest(digest) });
      const commitment = sealedResultCommitment(sealedResult);
      const evidence = buildEvidence({ orderDigest: digest, ciphertextCommitment: `sha256:${commitment.slice(2)}`, evaluation });
      const message = await settlement.evidenceMessageHash(orderId, hexDigest(digest), commitment, hexDigest(evidence.evidenceDigest));
      const signature = await verifier.signMessage(getBytes(message));
      const expected = {
        expectedOrderDigest: digest, expectedOrderId: orderId, expectedChainId: 31337,
        expectedContractAddress: contractAddress, expectedVerifierAddress: verifierAddress,
      };
      const bundle = await createEncryptedRecoveryBundle({ order, orderId, sealedResult, evidence, signature, verifierAddress });
      const paths = {
        bundle: `${directory}/${label}-bundle.json`, key: `${directory}/${label}-buyer-key.json`,
        context: `${directory}/${label}-trusted-context.json`,
      };
      await saveRecoveryBundle(paths.key, { recipientPrivateKey: recipient.privateKey });
      await saveRecoveryBundle(paths.context, expected);
      await saveRecoveryBundle(paths.bundle, bundle);
      assert.equal((await stat(paths.key)).mode & 0o777, 0o600);
      const saved = await loadRecoveryBundle(paths.bundle);
      assert.equal((await verifyEncryptedRecoveryBundle(saved, expected)).ok, true);
      assert.equal(JSON.stringify(saved).includes(recipient.privateKey), false);
      assert.equal(JSON.stringify(saved).includes('"allocations"'), false);
      assert.notDeepEqual(Buffer.from(sealedResult.ciphertext, "base64"), plaintext);
      return { orderId, order, digest, sealedResult, commitment, evidence, signature, expected, paths, plaintext, recipient };
    }

    async function fundAndSubmit(item, label) {
      await mined(settlement.fund(item.orderId, hexDigest(item.digest), providerAddress, providerAddress, item.order.deadline, { value: amount }), `${label}:fund`);
      return mined(settlement.connect(provider).submit(item.orderId, item.commitment), `${label}:submit`);
    }

    const valid = await prepare("settled");
    const validSubmitted = await fundAndSubmit(valid, "settled");
    const buyerNonceAtCheckpoint = await rpc.getTransactionCount(buyerAddress, validSubmitted.blockNumber);
    const buyerBalanceAtCheckpoint = await rpc.getBalance(buyerAddress, validSubmitted.blockNumber);
    const verified = await mined(settlement.connect(verifier).markVerified(valid.orderId, hexDigest(valid.digest), valid.commitment, hexDigest(valid.evidence.evidenceDigest), valid.signature), "settled:verify");
    assert.equal((await settlement.orders(valid.orderId, { blockTag: verified.blockNumber })).state, 3n);

    // The buyer sends no further transactions for this order, even after the verification window.
    await rpc.send("evm_setNextBlockTimestamp", [valid.order.deadline + verificationGrace + 1]);
    await rpc.send("evm_mine", []);
    const settled = await mined(settlement.connect(relayer).settle(valid.orderId), "settled:pay");
    assert.equal(settled.from, relayerAddress);
    const settlementTimestamp = Number((await rpc.getBlock(settled.blockNumber)).timestamp);
    assert.ok(settlementTimestamp > valid.order.deadline + verificationGrace);
    const buyerNonceAfterSettlement = await rpc.getTransactionCount(buyerAddress, settled.blockNumber);
    const buyerBalanceAfterSettlement = await rpc.getBalance(buyerAddress, settled.blockNumber);
    assert.equal(buyerNonceAfterSettlement, buyerNonceAtCheckpoint);
    assert.equal(buyerBalanceAfterSettlement, buyerBalanceAtCheckpoint);
    const relayerBefore = await rpc.getBalance(relayerAddress, settled.blockNumber - 1);
    const relayerAfter = await rpc.getBalance(relayerAddress, settled.blockNumber);
    assert.equal(relayerBefore - relayerAfter, settled.fee);
    const settledOrder = await settlement.orders(valid.orderId, { blockTag: settled.blockNumber });
    assert.equal(settledOrder.state, 4n);
    assert.equal(settledOrder.orderDigest, hexDigest(valid.digest));
    assert.equal(settledOrder.ciphertextCommitment, valid.commitment);
    assert.equal(settledOrder.evidenceDigest, hexDigest(valid.evidence.evidenceDigest));
    const payeeBefore = await rpc.getBalance(providerAddress, settled.blockNumber - 1);
    const payeeAfter = await rpc.getBalance(providerAddress, settled.blockNumber);
    assert.equal(payeeAfter - payeeBefore, amount);
    assert.equal(await rpc.getBalance(contractAddress, settled.blockNumber), 0n);
    const event = settled.logs.map((log) => settlement.interface.parseLog(log)).find((entry) => entry?.name === "Settled");
    assert.equal(event?.args.orderId, valid.orderId);
    assert.equal(event.args.payee, providerAddress);
    assert.equal(event.args.amount, amount);

    // Recovery runs in another process with only persisted files, without an RPC URL or provider callback.
    const recovery = await execFileAsync(process.execPath, [
      fileURLToPath(new URL("../scripts/recover-demo.mjs", import.meta.url)),
      valid.paths.bundle, valid.paths.key, valid.paths.context,
    ], { timeout: 10_000, signal: combinedSignal, maxBuffer: 1_000_000 });
    const recovered = JSON.parse(recovery.stdout);
    assert.equal(recovered.ok, true);
    assert.deepEqual(recovered.result, result);
    assert.equal(recovered.evaluation.scoreBps, 7960);

    const attack = await prepare("prepayment");
    const submitted = await fundAndSubmit(attack, "prepayment");
    const beforeAttack = await settlement.orders(attack.orderId, { blockTag: submitted.blockNumber });
    assert.equal(beforeAttack.state, 2n);
    assert.equal(beforeAttack.evidenceDigest, ZeroHash);
    const exposed = await openSealedResult({ sealedResult: attack.sealedResult, recipientPrivateKey: attack.recipient.privateKey, expectedOrderDigest: hexDigest(attack.digest) });
    assert.deepEqual(Buffer.from(exposed), attack.plaintext);
    const earlyRecovery = await recoverEncryptedResult(await loadRecoveryBundle(attack.paths.bundle), { ...attack.expected, recipientPrivateKey: attack.recipient.privateKey });
    assert.equal(earlyRecovery.ok, true);
    assert.deepEqual(earlyRecovery.result, result);
    await rpc.send("evm_setNextBlockTimestamp", [attack.order.deadline + verificationGrace + 1]);
    await rpc.send("evm_mine", []);
    const refund = await mined(settlement.refund(attack.orderId), "prepayment:refund");
    const buyerBefore = await rpc.getBalance(buyerAddress, refund.blockNumber - 1);
    const buyerAfter = await rpc.getBalance(buyerAddress, refund.blockNumber);
    const attackPayeeBefore = await rpc.getBalance(providerAddress, refund.blockNumber - 1);
    const attackPayeeAfter = await rpc.getBalance(providerAddress, refund.blockNumber);
    assert.equal(buyerAfter - buyerBefore + refund.fee, amount);
    assert.equal(attackPayeeBefore, attackPayeeAfter);
    assert.equal(await rpc.getBalance(contractAddress, refund.blockNumber - 1), amount);
    assert.equal(await rpc.getBalance(contractAddress, refund.blockNumber), 0n);
    assert.equal((await settlement.orders(attack.orderId, { blockTag: refund.blockNumber })).state, 5n);
    const refundEvent = refund.logs.map((log) => settlement.interface.parseLog(log)).find((entry) => entry?.name === "Refunded");
    assert.equal(refundEvent?.args.orderId, attack.orderId);
    assert.equal(refundEvent.args.buyer, buyerAddress);
    assert.equal(refundEvent.args.amount, amount);

    const sourceSha256 = {};
    for (const path of ["src/ProofOrderSettlement.sol", "src/order.mjs", "src/demo-flow.mjs", "src/sealed-result.mjs", "src/recovery.mjs", "src/evaluator.mjs", "src/evidence.mjs", "scripts/recover-demo.mjs", "scripts/run-demo.mjs", "scripts/local-demo.mjs", "package-lock.json"]) {
      sourceSha256[path] = createHash("sha256").update(await readFile(new URL(`../${path}`, import.meta.url))).digest("hex");
    }
    return {
      flow: "encrypted-delivery-and-exchange-boundary", status: "passed", generatedAt: new Date().toISOString(),
      environment: { node: process.version, ethers: version, clientVersion, chainId: 31337 }, sourceSha256, contractAddress,
      encryptedDelivery: {
        orderId: valid.orderId, orderDigest: valid.digest, ciphertextCommitment: valid.commitment,
        evidenceDigest: valid.evidence.evidenceDigest, suite: valid.sealedResult.suite,
        checkpointBeforeFunding: true, finalState: "Settled", recipientKeyFileMode: "0600",
        recovery: { independentProcess: true, rpcRequired: false, providerCallbackRequired: false, result: recovered.result, evaluation: recovered.evaluation,
          paths: Object.fromEntries(Object.entries(valid.paths).map(([key, value]) => [key, relative(fileURLToPath(new URL("../", import.meta.url)), value)])) },
        settlement: { transactionHash: settled.hash, blockNumber: settled.blockNumber, payeeBalanceBeforeWei: String(payeeBefore), payeeBalanceAfterWei: String(payeeAfter), payeeCreditWei: String(payeeAfter - payeeBefore), escrowBalanceAfterWei: "0" },
        buyerOfflineSettlement: {
          buyerAddress, providerAddress, verifierAddress, relayerAddress, payeeAddress: providerAddress,
          checkpointBlockNumber: validSubmitted.blockNumber, verificationTransactionHash: verified.hash,
          buyerNonceAtCheckpoint, buyerNonceAfterSettlement,
          buyerBalanceAtCheckpointWei: String(buyerBalanceAtCheckpoint), buyerBalanceAfterSettlementWei: String(buyerBalanceAfterSettlement),
          deadline: valid.order.deadline, verificationGraceSeconds: verificationGrace, settlementTimestamp,
          relayerBalanceBeforeWei: String(relayerBefore), relayerBalanceAfterWei: String(relayerAfter), relayerFeeWei: String(settled.fee),
          buyerTransactionsAfterCheckpoint: buyerNonceAfterSettlement - buyerNonceAtCheckpoint,
          paymentAuthorization: "Trusted verifier signature accepted on chain; any caller may pay the fixed payee.",
        },
      },
      exchangeBoundary: {
        status: "counterexample-reproduced", scenario: "Provider delivers the complete encrypted bundle, then stops before verification is mined. Buyer decrypts while Submitted, then obtains timeout refund.",
        orderId: attack.orderId, orderDigest: attack.digest, ciphertextCommitment: attack.commitment,
        decryptedBeforePayment: true, chainStateAtDecryption: "Submitted", chainEvidenceAtDecryption: ZeroHash,
        decryptBlockNumber: submitted.blockNumber, deadline: attack.order.deadline, verificationGraceSeconds: verificationGrace, finalState: "Refunded",
        refundTransactionHash: refund.hash, refundBlockNumber: refund.blockNumber,
        buyerBalanceBeforeWei: String(buyerBefore), buyerBalanceAfterWei: String(buyerAfter), refundFeeWei: String(refund.fee),
        buyerCreditPlusGasWei: String(buyerAfter - buyerBefore + refund.fee), providerCreditDuringRefundWei: String(attackPayeeAfter - attackPayeeBefore),
        result: JSON.parse(Buffer.from(exposed).toString("utf8")), fairExchangeEstablished: false,
      },
      inputs: { settledBundle: await loadRecoveryBundle(valid.paths.bundle), prepaymentBundle: await loadRecoveryBundle(attack.paths.bundle) },
      transactions,
      claimBoundary: "Real recipient encryption, offline recovery and fixed-payee settlement by a relayer after the buyer stops sending transactions, on local Anvil. Trusted verifier; no ZK. Verification authorizes payment without a further buyer approval and does not prove delivery. Recovery does not establish payment or finality. Complete HPKE delivery permits prepayment decryption; provider-abort trace disproves full fair exchange. Actors still share one orchestration process. A permanently reverting payee can still block payout.",
    };
  }
  let onAbort;
  const interrupted = new Promise((resolve, reject) => {
    onAbort = () => reject(combinedSignal.reason);
    combinedSignal.addEventListener("abort", onAbort, { once: true });
  });
  const timeout = setTimeout(() => controller.abort(new Error("Demo exceeded its deadline; transaction outcome may be unknown")), timeoutMs);
  try {
    combinedSignal.throwIfAborted();
    return await Promise.race([execute(), interrupted]);
  } finally {
    clearTimeout(timeout);
    combinedSignal.removeEventListener("abort", onAbort);
    rpc.destroy();
  }
}

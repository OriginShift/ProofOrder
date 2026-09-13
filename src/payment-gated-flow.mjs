import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ContractFactory, FetchRequest, JsonRpcProvider, getBytes, parseEther, version } from "ethers";
import { createPaymentGatedEnvelope, openPaymentGatedResult, paymentGatedCommitment } from "./payment-gated-experiment.mjs";
import { loadSettlementArtifact } from "./chain-client.mjs";

export async function runPaymentGatedFlow(rpcUrl, { signal, timeoutMs = 60_000 } = {}) {
  const url = new URL(rpcUrl);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  const request = new FetchRequest(url.href);
  request.timeout = 5_000;
  const rpc = new JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  rpc.pollingInterval = 100;
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const hash = (value) => `0x${createHash("sha256").update(value).digest("hex")}`;
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
    const artifact = await loadSettlementArtifact();
    const settlement = await new ContractFactory(artifact.abi, artifact.bytecode, buyer).deploy(verifierAddress);
    const deploy = await settlement.deploymentTransaction().wait(1, 15_000);
    const contractAddress = await settlement.getAddress();
    const amount = parseEther("1");
    const plaintext = Buffer.from(JSON.stringify({ gated: "released after settlement" }));
    const traces = [];
    const transactions = [{ action: "deploy", from: deploy.from, hash: deploy.hash, blockNumber: deploy.blockNumber, blockHash: deploy.blockHash }];
    for (const scenario of ["release", "withhold"]) {
      const orderId = `0x${randomBytes(32).toString("hex")}`;
      const latest = await rpc.send("eth_getBlockByNumber", ["latest", false]);
      const deadline = Number(BigInt(latest.timestamp)) + 900;
      const orderDigest = hash(`ProofOrder/PaymentGatedExperiment/order/v1|${orderId}|${contractAddress}|${buyerAddress}|${providerAddress}|${deadline}`);
      const { envelope, providerSecret } = createPaymentGatedEnvelope({ plaintext, orderDigest });
      const publicEnvelope = JSON.parse(JSON.stringify(envelope));
      const envelopeCommitment = paymentGatedCommitment(publicEnvelope);
      assert.throws(() => openPaymentGatedResult({ envelope: publicEnvelope, expectedOrderDigest: orderDigest, expectedEnvelopeCommitment: envelopeCommitment }), { code: "KEY_UNAVAILABLE" });
      const evidenceDigest = hash(`ProofOrder/PaymentGatedExperiment/evidence/v1|${envelopeCommitment}`);
      const message = await settlement.evidenceMessageHash(orderId, orderDigest, envelopeCommitment, evidenceDigest);
      const signature = await verifier.signMessage(getBytes(message));
      const fundTx = await settlement.fund(orderId, orderDigest, providerAddress, providerAddress, deadline, { value: amount });
      const fund = await fundTx.wait(1, 15_000);
      const submitTx = await settlement.connect(provider).submit(orderId, envelopeCommitment);
      const submit = await submitTx.wait(1, 15_000);
      const verifyTx = await settlement.connect(verifier).markVerified(orderId, orderDigest, envelopeCommitment, evidenceDigest, signature);
      const verify = await verifyTx.wait(1, 15_000);
      const settleTx = await settlement.connect(relayer).settle(orderId);
      const settle = await settleTx.wait(1, 15_000);
      transactions.push(...[
        { action: `${scenario}:fund`, from: fund.from, hash: fund.hash, blockNumber: fund.blockNumber, blockHash: fund.blockHash },
        { action: `${scenario}:submit`, from: submit.from, hash: submit.hash, blockNumber: submit.blockNumber, blockHash: submit.blockHash },
        { action: `${scenario}:verify`, from: verify.from, hash: verify.hash, blockNumber: verify.blockNumber, blockHash: verify.blockHash },
        { action: `${scenario}:settle`, from: settle.from, hash: settle.hash, blockNumber: settle.blockNumber, blockHash: settle.blockHash },
      ]);
      assert.equal((await settlement.orders(orderId, { blockTag: settle.blockNumber })).state, 4n);
      const payeeBefore = await rpc.getBalance(providerAddress, settle.blockNumber - 1);
      const payeeAfter = await rpc.getBalance(providerAddress, settle.blockNumber);
      assert.equal(payeeAfter - payeeBefore, amount);
      const record = { scenario, orderId, orderDigest, envelope: publicEnvelope, envelopeCommitment, prepaymentRecoveryError: "KEY_UNAVAILABLE", payment: { state: "Settled", blockNumber: settle.blockNumber, relayerAddress, payeeCreditWei: String(payeeAfter - payeeBefore), escrowAfterWei: String(await rpc.getBalance(contractAddress, settle.blockNumber)) } };
      if (scenario === "release") {
        assert.deepEqual(Buffer.from(openPaymentGatedResult({ envelope: publicEnvelope, releasedKey: providerSecret.releasedKey, expectedOrderDigest: orderDigest, expectedEnvelopeCommitment: envelopeCommitment })), plaintext);
        record.recovery = { keyReleasedAfterSettlement: true, decrypted: true };
      } else {
        assert.throws(() => openPaymentGatedResult({ envelope: publicEnvelope, expectedOrderDigest: orderDigest, expectedEnvelopeCommitment: envelopeCommitment }), { code: "KEY_UNAVAILABLE" });
        record.recovery = { keyReleasedAfterSettlement: false, decrypted: false, postPaymentError: "KEY_UNAVAILABLE" };
      }
      traces.push(record);
    }
    return { experiment: "deferred-key-release-on-anvil", status: "passed", candidateResult: "fails-fair-exchange", generatedAt: new Date().toISOString(), environment: { node: process.version, ethers: version, clientVersion, chainId: 31337 }, contractAddress, buyerAddress, providerAddress, verifierAddress, relayerAddress, traces, transactions, claimBoundary: "Mined local Anvil payments and fixed-payee settlement. Prepayment decryption is blocked by the missing key, but provider key release remains voluntary after payment. The candidate is not a production fair-exchange protocol; no ZK or trustless release is claimed." };
  }
  let onAbort;
  const interrupted = new Promise((resolve, reject) => { onAbort = () => reject(combinedSignal.reason); combinedSignal.addEventListener("abort", onAbort, { once: true }); });
  const timer = setTimeout(() => controller.abort(new Error("Deferred-key flow exceeded its deadline")), timeoutMs);
  try { return await Promise.race([execute(), interrupted]); } finally { clearTimeout(timer); combinedSignal.removeEventListener("abort", onAbort); rpc.destroy(); }
}

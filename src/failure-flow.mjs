import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ContractFactory, FetchRequest, JsonRpcProvider, ZeroHash, getBytes, keccak256, parseEther, version } from "ethers";

export async function expectContractError(call, abi, expectedName) {
  let failure;
  try {
    await call();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `Expected ${expectedName}, but the call succeeded`);
  assert.equal(failure.code, "CALL_EXCEPTION", "RPC or client failures are not contract rejections");
  assert.equal(typeof failure.data, "string", "Missing revert data");
  const decoded = abi.parseError(failure.data);
  assert.equal(decoded?.name, expectedName, "Unexpected contract error");
  return { error: decoded.name, revertData: failure.data };
}

export async function runFailureFlow(rpcUrl, { signal, timeoutMs = 60_000 } = {}) {
  const url = new URL(rpcUrl);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Failure demo requires a dedicated local Anvil HTTP endpoint");
  const request = new FetchRequest(url.href);
  request.timeout = 5_000;
  // Anvil mines synchronously; cached latest reads can refer to the previous transaction.
  const rpc = new JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  rpc.pollingInterval = 100;
  async function execute() {
    const clientVersion = await rpc.send("web3_clientVersion", []);
    assert.match(clientVersion, /anvil/i, "Refusing time travel on a non-Anvil node");
    assert.equal(BigInt(await rpc.send("eth_chainId", [])), 31337n, "Expected local chain 31337");
    const buyer = await rpc.getSigner(0);
    const serviceProvider = await rpc.getSigner(1);
    const verifier = await rpc.getSigner(2);
    const buyerAddress = await buyer.getAddress();
    const providerAddress = await serviceProvider.getAddress();
    const verifierAddress = await verifier.getAddress();
    const artifact = JSON.parse(await readFile(new URL("../out/ProofOrderSettlement.sol/ProofOrderSettlement.json", import.meta.url), "utf8"));
    const transactions = [];
    async function mined(transaction, action) {
      const tx = await transaction;
      const receipt = await tx.wait(1, 15_000);
      assert.ok(receipt, `${action}: missing receipt`);
      assert.equal(receipt.status, 1, `${action}: transaction failed`);
      transactions.push({ action, hash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
      return receipt;
    }
    const settlement = await new ContractFactory(artifact.abi, artifact.bytecode, buyer).deploy(verifierAddress);
    await mined(settlement.deploymentTransaction(), "deploy");
    const settlementAddress = await settlement.getAddress();
    const hash = (label) => keccak256(Buffer.from(label));
    const amount = parseEther("1");
    const submittedId = hash("failure-demo-submitted");
    const absentId = hash("failure-demo-provider-absent");
    const orderDigest = hash("failure-demo-order-digest");
    const absentDigest = hash("failure-demo-absent-digest");
    const commitment = hash("failure-demo-placeholder-ciphertext");
    const evidenceDigest = hash("failure-demo-placeholder-evidence");
    const latestBlock = () => rpc.send("eth_getBlockByNumber", ["latest", false]);
    const nextDeadline = async () => BigInt((await latestBlock()).timestamp) + 3600n;

    await mined(settlement.fund(submittedId, orderDigest, providerAddress, providerAddress, await nextDeadline(), { value: amount }), "fund-submitted");
    await mined(settlement.connect(serviceProvider).submit(submittedId, commitment), "submit");
    await mined(settlement.fund(absentId, absentDigest, providerAddress, providerAddress, await nextDeadline(), { value: amount }), "fund-provider-absent");
    const fundedBlock = Number(BigInt((await latestBlock()).number));
    const submitted = await settlement.orders(submittedId, { blockTag: fundedBlock });
    const absent = await settlement.orders(absentId, { blockTag: fundedBlock });
    assert.equal(submitted.state, 2n);
    assert.equal(absent.state, 1n);
    assert.equal(submitted.evidenceDigest, ZeroHash);
    assert.equal(await rpc.getBalance(settlementAddress, fundedBlock), 2n * amount);
    const message = getBytes(await settlement.evidenceMessageHash(submittedId, orderDigest, commitment, evidenceDigest));
    const validSignature = await verifier.signMessage(message);
    const wrongSignature = await buyer.signMessage(message);
    const rejectedCalls = [];

    async function snapshot() {
      const blockNumber = Number(BigInt((await latestBlock()).number));
      const actors = [buyerAddress, providerAddress, verifierAddress];
      return {
        blockNumber,
        orders: await Promise.all([submittedId, absentId].map(async (id) => Array.from(await settlement.orders(id, { blockTag: blockNumber }), String))),
        balances: await Promise.all([...actors, settlementAddress].map(async (address) => String(await rpc.getBalance(address, blockNumber)))),
        pendingNonces: await Promise.all(actors.map((address) => rpc.send("eth_getTransactionCount", [address, "pending"]))),
      };
    }
    async function rejected(scenario, call, expectedName) {
      const before = await snapshot();
      const error = await expectContractError(call, settlement.interface, expectedName);
      assert.deepEqual(await snapshot(), before, `${scenario}: state, balance or nonce changed`);
      rejectedCalls.push({ scenario, ...error, blockNumber: before.blockNumber, stateBalancesAndNoncesUnchanged: true, simulation: true });
    }

    const beforePositiveControl = await snapshot();
    await settlement.markVerified.staticCall(submittedId, orderDigest, commitment, evidenceDigest, validSignature);
    assert.deepEqual(await snapshot(), beforePositiveControl, "Positive control must remain a simulation");
    await rejected("wrong-verifier-signature", () => settlement.markVerified.staticCall(submittedId, orderDigest, commitment, evidenceDigest, wrongSignature), "InvalidSignature");
    await rejected("changed-order-digest", () => settlement.markVerified.staticCall(submittedId, hash("changed-order-digest"), commitment, evidenceDigest, validSignature), "InvalidOrder");
    await rejected("changed-ciphertext-commitment", () => settlement.markVerified.staticCall(submittedId, orderDigest, hash("changed-ciphertext"), evidenceDigest, validSignature), "InvalidOrder");
    await rejected("changed-evidence-digest", () => settlement.markVerified.staticCall(submittedId, orderDigest, commitment, hash("changed-evidence"), validSignature), "InvalidSignature");
    await rejected("settle-before-verification", () => settlement.settle.staticCall(submittedId), "InvalidState");
    await rejected("submitted-refund-before-deadline", () => settlement.refund.staticCall(submittedId), "DeadlineNotReached");
    await rejected("funded-refund-before-deadline", () => settlement.refund.staticCall(absentId), "DeadlineNotReached");

    const expiry = submitted.deadline > absent.deadline ? submitted.deadline : absent.deadline;
    await rpc.send("evm_setNextBlockTimestamp", [Number(expiry + 1n)]);
    await rpc.send("evm_mine", []);
    const expiryBlock = await latestBlock();
    assert.equal(BigInt(expiryBlock.timestamp), expiry + 1n);
    await rejected("submit-after-deadline", () => settlement.connect(serviceProvider).submit.staticCall(absentId, commitment), "DeadlinePassed");
    await rejected("submitted-refund-during-verification-grace", () => settlement.refund.staticCall(submittedId), "DeadlineNotReached");
    const grace = await settlement.VERIFICATION_GRACE();
    await rpc.send("evm_setNextBlockTimestamp", [Number(expiry + grace + 1n)]);
    await rpc.send("evm_mine", []);

    const refunds = [];
    for (const [id, initialState] of [[absentId, 1n], [submittedId, 2n]]) {
      const receipt = await mined(settlement.refund(id), `refund-${initialState === 1n ? "provider-absent" : "submitted"}`);
      const before = receipt.blockNumber - 1;
      const after = receipt.blockNumber;
      const recordBefore = await settlement.orders(id, { blockTag: before });
      const recordAfter = await settlement.orders(id, { blockTag: after });
      assert.equal(recordBefore.state, initialState);
      assert.equal(recordAfter.state, 5n);
      const events = receipt.logs.filter((log) => log.address.toLowerCase() === settlementAddress.toLowerCase())
        .map((log) => settlement.interface.parseLog(log)).filter((event) => event?.name === "Refunded");
      assert.equal(events.length, 1, "Expected exactly one Refunded event");
      const event = events[0].args;
      assert.equal(event.orderId, id);
      assert.equal(event.buyer, buyerAddress);
      assert.equal(event.amount, recordBefore.amount);
      const escrowBefore = await rpc.getBalance(settlementAddress, before);
      const escrowAfter = await rpc.getBalance(settlementAddress, after);
      const buyerBefore = await rpc.getBalance(buyerAddress, before);
      const buyerAfter = await rpc.getBalance(buyerAddress, after);
      const payeeBefore = await rpc.getBalance(providerAddress, before);
      const payeeAfter = await rpc.getBalance(providerAddress, after);
      assert.equal(escrowBefore - escrowAfter, event.amount, "Escrow debit differs from refund");
      assert.equal(buyerAfter - buyerBefore + receipt.fee, event.amount, "Buyer credit including gas differs from refund");
      assert.equal(payeeAfter, payeeBefore, "Provider must not be paid on refund");
      refunds.push({
        orderId: id, initialState: Number(initialState), finalState: Number(recordAfter.state), finalStateName: "Refunded",
        buyer: event.buyer, refundAmountWei: String(event.amount), transactionHash: receipt.hash,
        blockNumber: after, blockHash: receipt.blockHash, balanceBeforeBlock: before,
        escrowBalanceBeforeWei: String(escrowBefore), escrowBalanceAfterWei: String(escrowAfter),
        buyerBalanceBeforeWei: String(buyerBefore), buyerBalanceAfterWei: String(buyerAfter),
        transactionFeeWei: String(receipt.fee), buyerCreditPlusGasWei: String(buyerAfter - buyerBefore + receipt.fee),
        payeeBalanceBeforeWei: String(payeeBefore), payeeBalanceAfterWei: String(payeeAfter),
      });
      await rejected(`repeat-refund-${initialState === 1n ? "provider-absent" : "submitted"}`, () => settlement.refund.staticCall(id), "InvalidState");
    }
    const finalBlock = Number(BigInt((await latestBlock()).number));
    assert.equal(await rpc.getBalance(settlementAddress, finalBlock), 0n);
    const sourceSha256 = {};
    for (const path of ["src/ProofOrderSettlement.sol", "src/failure-flow.mjs", "scripts/run-failure-demo.mjs", "scripts/local-demo.mjs", "package-lock.json"]) {
      sourceSha256[path] = createHash("sha256").update(await readFile(new URL(`../${path}`, import.meta.url))).digest("hex");
    }
    return {
      flow: "failure-boundaries", status: "passed", generatedAt: new Date().toISOString(),
      environment: { node: process.version, ethers: version, clientVersion, chainId: 31337 }, sourceSha256,
      settlementAddress, buyerAddress, providerAddress, verifierAddress,
      inputs: { submittedId, absentId, orderDigest, absentDigest, commitment, evidenceDigest, amountWei: String(amount),
        submittedDeadline: String(submitted.deadline), absentDeadline: String(absent.deadline), validSignature, wrongSignature },
      positiveControl: { authorizedSignatureAccepted: true, simulation: true, stateBalancesAndNoncesUnchanged: true },
      rejectedCalls, refunds, finalEscrowBalanceWei: "0", transactions,
      expiryBlock: { number: Number(BigInt(expiryBlock.number)), hash: expiryBlock.hash, timestamp: Number(BigInt(expiryBlock.timestamp)) },
      claimBoundary: "Local Anvil: rejection probes are eth_call simulations; funding, submission and refunds are mined transactions. Placeholder commitments; no encryption, ZK proof, public testnet finality, deadline-race or interruption-retry claim.",
    };
  }
  let rejectCancelled;
  const cancelled = new Promise((resolve, reject) => { rejectCancelled = reject; });
  const onAbort = () => rejectCancelled(signal.reason ?? new Error("Failure demo interrupted"));
  let timeout;
  try {
    signal?.throwIfAborted();
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => rejectCancelled(new Error(`Failure demo exceeded ${timeoutMs} ms; transaction outcome may be unknown`)), timeoutMs);
    return await Promise.race([execute(), cancelled]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    rpc.destroy();
  }
}

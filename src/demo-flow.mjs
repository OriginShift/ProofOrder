import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { ContractFactory, JsonRpcProvider, NonceManager, Wallet, getBytes, keccak256, parseEther } from "ethers";
import { buildEvidence } from "./evidence.mjs";
import { evaluateAllocation } from "./evaluator.mjs";
import { orderDigest } from "./order.mjs";

const RPC_URL = process.env.PROOFORDER_RPC_URL ?? "http://127.0.0.1:8545";
const ANVIL_KEYS = {
  buyer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  provider: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  verifier: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

const artifact = JSON.parse(await readFile("out/ProofOrderSettlement.sol/ProofOrderSettlement.json", "utf8"));
const provider = new JsonRpcProvider(RPC_URL);
const buyer = new NonceManager(new Wallet(ANVIL_KEYS.buyer, provider));
const serviceProvider = new NonceManager(new Wallet(ANVIL_KEYS.provider, provider));
const verifierWallet = new Wallet(ANVIL_KEYS.verifier, provider);
const verifier = new NonceManager(verifierWallet);
const buyerAddress = await buyer.getAddress();
const providerAddress = await serviceProvider.getAddress();
const verifierAddress = await verifier.getAddress();
const settlement = await new ContractFactory(artifact.abi, artifact.bytecode, buyer).deploy(verifierAddress);
await settlement.waitForDeployment();

const order = { nonce: 1, buyer: buyerAddress, provider: providerAddress, payee: providerAddress };
const digest = await orderDigest(order);
const orderDigestHex = `0x${Buffer.from(digest).toString("hex")}`;
const allocation = {
  snapshot: {
    id: "fixed-snapshot-001",
    targets: [
      { id: "target-a", liquidityBps: 9000, scoreBps: 8200 },
      { id: "target-b", liquidityBps: 8000, scoreBps: 7600 },
    ],
  },
  allocations: [
    { target: "target-a", amountMinorUnits: 6000 },
    { target: "target-b", amountMinorUnits: 4000 },
  ],
};
const evaluation = evaluateAllocation(allocation);
if (!evaluation.ok) throw new Error(`evaluation failed: ${evaluation.code}`);
const ciphertext = Buffer.from(JSON.stringify({ sealed: "demo-result", allocation }));
const ciphertextCommitment = `0x${createHash("sha256").update(ciphertext).digest("hex")}`;
const evidence = buildEvidence({
  orderDigest: `sha256:${Buffer.from(digest).toString("hex")}`,
  ciphertextCommitment: `sha256:${ciphertextCommitment.slice(2)}`,
  evaluation,
});
const evidenceDigest = `0x${evidence.evidenceDigest.slice("sha256:".length)}`;
const orderId = keccak256(Buffer.from("prooforder-demo-1"));
const latest = await provider.getBlock("latest");
const deadline = BigInt(latest.timestamp + 900);
const providerBefore = await provider.getBalance(providerAddress);

await (await settlement.fund(orderId, orderDigestHex, providerAddress, providerAddress, deadline, { value: parseEther("1") })).wait();
await (await settlement.connect(serviceProvider).submit(orderId, ciphertextCommitment)).wait();
const messageHash = await settlement.evidenceMessageHash(orderId, orderDigestHex, ciphertextCommitment, evidenceDigest);
const signature = await verifierWallet.signMessage(getBytes(messageHash));
await (await settlement.markVerified(orderId, orderDigestHex, ciphertextCommitment, evidenceDigest, signature)).wait();
await (await settlement.settle(orderId)).wait();
const providerAfter = await provider.getBalance(providerAddress);
const record = await settlement.orders(orderId);

console.log(JSON.stringify({
  flow: "buyer -> provider -> verifier -> settlement",
  contract: await settlement.getAddress(),
  orderId,
  orderDigest: orderDigestHex,
  ciphertextCommitment,
  evidenceDigest,
  evaluation,
  providerBalanceDeltaWei: (providerAfter - providerBefore).toString(),
  settlementBalanceWei: (await provider.getBalance(await settlement.getAddress())).toString(),
  finalState: Number(record.state),
  finalStateName: ["None", "Funded", "Submitted", "Verified", "Settled", "Refunded"][Number(record.state)],
  claimBoundary: "local Anvil flow with ECDSA-signed deterministic evaluator evidence; not a ZK proof",
}, null, 2));

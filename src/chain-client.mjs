// Shared local-chain access for the buyer/provider/verifier CLIs.
//
// Bounded to a loopback Anvil node with the frozen chain id: the CLIs exist to exercise the local
// workflow, not to talk to a public network.
import { readFile } from "node:fs/promises";
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider } from "ethers";
import { LOCAL_CHAIN_ID } from "./constants.mjs";

// Forge's output directory is configurable (this environment sets `out = "artifacts"`, the
// repository default is `out`), so the artifact is resolved from the known candidates instead of
// assuming one.
const ARTIFACT_RELATIVE_PATHS = [
  "../artifacts/ProofOrderSettlement.sol/ProofOrderSettlement.json",
  "../out/ProofOrderSettlement.sol/ProofOrderSettlement.json",
];

export function settlementArtifactCandidates() {
  return ARTIFACT_RELATIVE_PATHS.map((relative) => new URL(relative, import.meta.url));
}

export async function loadSettlementArtifact() {
  const tried = [];
  for (const url of settlementArtifactCandidates()) {
    try {
      const parsed = JSON.parse(await readFile(url, "utf8"));
      // solc standard-JSON artifacts carry `bytecode.object`; forge's flat form carries a string.
      const bytecode = typeof parsed?.bytecode === "string" ? parsed.bytecode : parsed?.bytecode?.object;
      if (Array.isArray(parsed?.abi) && typeof bytecode === "string") return parsed;
      tried.push(`${url.pathname} (no abi/bytecode)`);
    } catch (error) {
      tried.push(`${url.pathname} (${error.code ?? error.message})`);
    }
  }
  throw Object.assign(
    new Error(`Missing contract artifact; run \`forge build\` before the CLI workflow. Tried: ${tried.join(", ")}`),
    { code: "ARTIFACT_MISSING", tried },
  );
}

export async function connectLocal(rpcUrl) {
  const url = new URL(rpcUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw Object.assign(new Error("Refusing a non-loopback RPC endpoint"), { code: "RPC_NOT_LOCAL" });
  }
  const request = new FetchRequest(url.href);
  request.timeout = 5_000;
  const provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 100;
  try {
    const clientVersion = await provider.send("web3_clientVersion", []);
    if (!/anvil/i.test(clientVersion)) throw Object.assign(new Error("Refusing a non-Anvil node"), { code: "RPC_NOT_ANVIL" });
    const chainId = Number(await provider.send("eth_chainId", []));
    if (chainId !== LOCAL_CHAIN_ID) {
      throw Object.assign(new Error(`Expected local chain ${LOCAL_CHAIN_ID}, got ${chainId}`), { code: "CHAIN_MISMATCH" });
    }
    return { provider, chainId, clientVersion, rpcUrl: url.href };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}

export async function deploySettlement({ provider, signer, verifierAddress, artifact }) {
  const compiled = artifact ?? await loadSettlementArtifact();
  const factory = new ContractFactory(compiled.abi, compiled.bytecode, signer);
  const contract = await factory.deploy(verifierAddress);
  const receipt = await (await contract.deploymentTransaction()).wait(1, 15_000);
  if (receipt?.status !== 1) throw new Error("Settlement deployment failed");
  return { contract, address: await contract.getAddress(), transactionHash: receipt.hash, blockNumber: receipt.blockNumber, abi: compiled.abi };
}

export function settlementAt({ address, abi, runner }) {
  return new Contract(address, abi, runner);
}

export function createReceiptRecorder() {
  const transactions = [];
  async function mined(pending, action) {
    const receipt = await (await pending).wait(1, 15_000);
    if (!receipt || receipt.status !== 1) throw new Error(`${action}: transaction failed`);
    transactions.push({ action, hash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, from: receipt.from });
    return receipt;
  }
  return { mined, transactions };
}

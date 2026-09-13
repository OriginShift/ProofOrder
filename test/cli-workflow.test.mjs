// End-to-end CLI harness: every participant is a separate OS process against a fresh local Anvil,
// so the buyer checkpoint, provider delivery, verifier attestation and release are exercised across
// process boundaries instead of inside one orchestration function.
//
// Covered traces:
//   happy path        init -> fund -> provider submit -> verifier attest (independent re-evaluation)
//                     -> buyer verify -> buyer release -> buyer recover, with delivery never inferred
//   timeout refund    init -> fund -> advance -> refund, with no provider bundle in the directory
//   tampered evidence the verifier signs nothing when the claim contradicts the committed result
//   order binding     the provider refuses a mismatched digest before writing or sending anything
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { freePort, stopChild, waitForAnvil } from "../scripts/local-demo.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Forge's out directory is configurable, so both known locations are accepted.
const artifactCandidates = ["artifacts", "out"].map((dir) => join(root, dir, "ProofOrderSettlement.sol/ProofOrderSettlement.json"));

function resolveBin(name) {
  const override = process.env[`${name.toUpperCase()}_BIN`];
  if (override && existsSync(override)) return override;
  const candidates = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const resolved = join(dir, candidate);
      if (existsSync(resolved)) return resolved;
    }
  }
  const homes = [process.env.USERPROFILE, process.env.HOME].filter(Boolean);
  for (const home of homes) {
    for (const candidate of candidates) {
      const foundry = join(home, ".foundry", "bin", candidate);
      if (existsSync(foundry)) return foundry;
    }
  }
  return undefined;
}

const anvilBin = resolveBin("anvil");
const forgeBin = resolveBin("forge");

let child;
let childState;
let rpcUrl;
const directories = [];

function trackChild(process_) {
  const state = { output: "", ended: false, error: undefined };
  process_.stdout?.on("data", (chunk) => { state.output += chunk; });
  process_.stderr?.on("data", (chunk) => { state.output += chunk; });
  process_.once("error", (error) => { state.error = error; });
  state.promise = new Promise((resolve) => {
    process_.once("close", (code, signal) => {
      state.ended = true;
      resolve({ code, signal });
    });
  });
  return state;
}

function runNodeCli(script, args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [join(root, "scripts", script), ...args], { cwd: root, env: process.env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.once("close", (code) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = undefined;
      }
      resolve({ code, stdout, stderr, json: parsed });
    });
  });
}

async function step(script, args) {
  const result = await runNodeCli(script, args);
  assert.ok(result.json, `${script} ${args[0]} printed no JSON (exit ${result.code}): ${result.stderr || result.stdout}`);
  return result;
}

async function must(script, args, label) {
  const result = await step(script, args);
  assert.equal(result.json.ok, true, `${label}: ${JSON.stringify(result.json)}`);
  assert.equal(result.code, 0, `${label}: exit code ${result.code}`);
  return result.json;
}

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

async function advance(seconds) {
  await rpc("evm_increaseTime", [seconds]);
  await rpc("evm_mine", []);
}

async function newDir() {
  const dir = await mkdtemp(join(tmpdir(), "prooforder-cli-"));
  directories.push(dir);
  return dir;
}

async function prepareSubmitted(deadlineSeconds = 900) {
  const dir = await newDir();
  const init = await must("buyer-cli.mjs", ["init", "--rpc", rpcUrl, "--dir", dir, "--deadline-seconds", String(deadlineSeconds)], "init");
  await must("buyer-cli.mjs", ["fund", "--rpc", rpcUrl, "--dir", dir], "fund");
  const submit = await must("provider-cli.mjs", ["submit", "--rpc", rpcUrl, "--dir", dir], "provider submit");
  return { dir, init, submit };
}

before(async () => {
  assert.ok(anvilBin, "anvil is required for the CLI end-to-end harness (foundry must be installed)");
  if (!artifactCandidates.some((candidate) => existsSync(candidate))) {
    assert.ok(forgeBin, "forge is required to build the settlement artifact");
    const build = spawnSync(forgeBin, ["build"], { cwd: root, encoding: "utf8" });
    assert.equal(build.status, 0, `forge build failed: ${build.stderr ?? build.stdout}`);
  }
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  child = spawn(anvilBin, ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"], { cwd: root });
  childState = trackChild(child);
  await waitForAnvil(rpcUrl, childState, new AbortController().signal);
});

after(async () => {
  if (child && childState && !childState.ended) await stopChild(child, childState);
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("the full workflow runs as separate processes and never infers delivery", async () => {
  const dir = await newDir();
  const init = await must("buyer-cli.mjs", ["init", "--rpc", rpcUrl, "--dir", dir], "init");
  assert.equal(init.checkpointWrittenBeforeFunding, true);
  assert.match(init.orderDigest, /^sha256:[0-9a-f]{64}$/);

  // init must never run over an existing workflow.
  const reinit = await step("buyer-cli.mjs", ["init", "--rpc", rpcUrl, "--dir", dir]);
  assert.equal(reinit.json.ok, false);
  assert.equal(reinit.json.code, "EXISTING_STATE");
  assert.equal((await readFile(join(dir, "checkpoint.json"), "utf8")).includes(init.orderId), true);

  const beforeFunding = await must("buyer-cli.mjs", ["status", "--rpc", rpcUrl, "--dir", dir], "status");
  assert.equal(beforeFunding.state, null);
  assert.equal(beforeFunding.funding.funded, false);
  assert.equal(beforeFunding.verification.submitted, false);
  assert.equal(beforeFunding.delivery.observed, false);
  assert.equal(beforeFunding.decision.action, "fund");
  assert.equal(beforeFunding.observed.code, "ORDER_NOT_FOUND");

  await must("buyer-cli.mjs", ["fund", "--rpc", rpcUrl, "--dir", dir], "fund");

  const submit = await must("provider-cli.mjs", ["submit", "--rpc", rpcUrl, "--dir", dir], "provider submit");
  assert.equal(submit.orderDigest, init.orderDigest);
  assert.equal(submit.orderId, init.orderId);
  assert.equal(submit.includesPlaintext, false);
  assert.equal(submit.transactions.length, 1);

  // A repeated submit must not overwrite the delivered ciphertext nor send another transaction.
  const submissionPath = join(dir, "provider-submission.json");
  const persisted = await readFile(submissionPath, "utf8");
  const repeat = await must("provider-cli.mjs", ["submit", "--rpc", rpcUrl, "--dir", dir], "repeated submit");
  assert.equal(repeat.repeatedSubmit, true);
  assert.equal(repeat.transactionSubmitted, false);
  assert.equal(repeat.submissionFileRewritten, false);
  assert.equal(await readFile(submissionPath, "utf8"), persisted);

  const attest = await must(
    "verifier-cli.mjs",
    ["attest", "--rpc", rpcUrl, "--dir", dir, "--verification-key-file", join(dir, "recipient-key.json")],
    "verifier attest",
  );
  assert.equal(attest.verificationPath, "independent-decrypt-and-reevaluate");
  assert.equal(attest.independentlyReEvaluated, true);
  assert.equal(attest.disclosure.verifierDecryptionCapability, true);
  assert.equal(attest.publishedOnChain, true);
  assert.equal(attest.evaluation.scoreBps, 7960);
  assert.equal(attest.deliveryObserved, false);

  const verify = await must("buyer-cli.mjs", ["verify", "--dir", dir], "buyer verify");
  assert.equal(verify.decision, "accept-and-checkpoint");
  assert.equal(verify.deliveryObserved, false);
  assert.equal(verify.chainStateQueried, false);

  const beforeRelease = await must("buyer-cli.mjs", ["status", "--rpc", rpcUrl, "--dir", dir], "status");
  assert.equal(beforeRelease.state, "Verified");
  assert.equal(beforeRelease.decision.action, "settle");
  assert.equal(beforeRelease.delivery.observed, false);
  assert.deepEqual(beforeRelease.funding.funded, true);

  const release = await must("buyer-cli.mjs", ["release", "--rpc", rpcUrl, "--dir", dir], "release");
  assert.equal(release.action, "settle");
  assert.equal(release.payeeCreditWei, init.amountWei);
  assert.equal(release.buyerTransactionsAfterCheckpoint, 0);

  const settled = await must("buyer-cli.mjs", ["status", "--rpc", rpcUrl, "--dir", dir], "status");
  assert.equal(settled.state, "Settled");
  assert.equal(settled.delivery.observed, false);
  assert.equal(settled.decision.action, "complete");

  const recover = await must("buyer-cli.mjs", ["recover", "--dir", dir], "recover");
  assert.deepEqual(recover.result.allocations, [
    { target: "target-a", amountMinorUnits: 6000 },
    { target: "target-b", amountMinorUnits: 4000 },
  ]);
  assert.deepEqual(recover.evaluation, attest.evaluation);
  assert.equal(recover.settlementStatus, "not-queried");
  assert.equal(recover.rpcRequired, false);
});

test("a timeout refund needs the checkpoint and the chain only, never a provider bundle", async () => {
  const dir = await newDir();
  const init = await must("buyer-cli.mjs", ["init", "--rpc", rpcUrl, "--dir", dir, "--deadline-seconds", "120", "--amount-wei", "500000000000000000"], "init");
  await must("buyer-cli.mjs", ["fund", "--rpc", rpcUrl, "--dir", dir], "fund");

  const early = await step("buyer-cli.mjs", ["refund", "--rpc", rpcUrl, "--dir", dir]);
  assert.equal(early.json.ok, false);
  assert.equal(early.json.code, "CHAIN_NOT_READY");
  assert.equal(early.json.nextAction, "await-submission");

  await advance(180);
  const refund = await must("buyer-cli.mjs", ["refund", "--rpc", rpcUrl, "--dir", dir], "refund");
  assert.equal(refund.action, "refund");
  assert.equal(refund.bundleRequired, false);
  assert.equal(refund.bundleRead, false);
  assert.equal(refund.transactions.length, 1);
  assert.equal(refund.escrowBalanceAfterWei, "0");

  // No bundle was needed and none was ever written for this buyer.
  assert.equal(existsSync(join(dir, "bundle.json")), false);
  assert.equal(init.orderId, refund.orderId);

  const status = await must("buyer-cli.mjs", ["status", "--rpc", rpcUrl, "--dir", dir], "status");
  assert.equal(status.state, "Refunded");
  assert.equal(status.verification.submitted, false);
  assert.equal(status.delivery.observed, false);

  // The release path still requires a bundle, which is why the refund command exists.
  const release = await step("buyer-cli.mjs", ["release", "--rpc", rpcUrl, "--dir", dir]);
  assert.equal(release.json.ok, false);
  assert.equal(release.json.code, "MISSING_FILE");
});

test("a tampered claim is rejected and nothing is signed", async () => {
  const { dir } = await prepareSubmitted();
  const submissionPath = join(dir, "provider-submission.json");
  const submission = JSON.parse(await readFile(submissionPath, "utf8"));
  submission.evidence.evaluation.scoreBps = 9999;
  await writeFile(submissionPath, `${JSON.stringify(submission, null, 2)}\n`);

  const attest = await step("verifier-cli.mjs", ["attest", "--rpc", rpcUrl, "--dir", dir, "--verification-key-file", join(dir, "recipient-key.json")]);
  assert.equal(attest.json.ok, false, JSON.stringify(attest.json));
  assert.ok(["EVALUATION_MISMATCH", "EVIDENCE_MISMATCH"].includes(attest.json.code), JSON.stringify(attest.json));
  assert.equal(existsSync(join(dir, "bundle.json")), false, "the verifier must not write an attestation it could not re-derive");

  const chainState = await must("buyer-cli.mjs", ["status", "--rpc", rpcUrl, "--dir", dir], "status");
  assert.equal(chainState.state, "Submitted", "the tampered claim must not have changed the chain state");
  assert.equal(chainState.decision.action, "await-verification");
});

test("a tampered recovery bundle is rejected by the buyer's offline verification", async () => {
  const { dir } = await prepareSubmitted();
  await must("verifier-cli.mjs", ["attest", "--rpc", rpcUrl, "--dir", dir, "--verification-key-file", join(dir, "recipient-key.json")], "verifier attest");

  const bundlePath = join(dir, "bundle.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundle.evidence.evaluation.scoreBps, 7960);
  bundle.evidence.evaluation.scoreBps = 9999;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);

  const verify = await step("buyer-cli.mjs", ["verify", "--dir", dir]);
  assert.equal(verify.json.ok, false);
  assert.equal(verify.json.code, "EVIDENCE_MISMATCH");
});

test("the provider refuses a mismatched order binding before writing or submitting", async () => {
  const { dir } = await prepareSubmitted();

  const tamperedDigest = await newDir();
  await must("buyer-cli.mjs", ["init", "--rpc", rpcUrl, "--dir", tamperedDigest], "init");
  await must("buyer-cli.mjs", ["fund", "--rpc", rpcUrl, "--dir", tamperedDigest], "fund");
  const orderPath = join(tamperedDigest, "order.json");
  const orderFile = JSON.parse(await readFile(orderPath, "utf8"));
  orderFile.orderDigest = `sha256:${"ab".repeat(32)}`;
  await writeFile(orderPath, `${JSON.stringify(orderFile, null, 2)}\n`);
  const mismatch = await step("provider-cli.mjs", ["submit", "--rpc", rpcUrl, "--dir", tamperedDigest]);
  assert.equal(mismatch.json.ok, false);
  assert.equal(mismatch.json.code, "ORDER_DIGEST_MISMATCH");
  assert.equal(existsSync(join(tamperedDigest, "provider-submission.json")), false);

  // An unfunded order is refused from the chain read, still without writing anything.
  const unfunded = await newDir();
  await must("buyer-cli.mjs", ["init", "--rpc", rpcUrl, "--dir", unfunded], "init");
  const tooEarly = await step("provider-cli.mjs", ["submit", "--rpc", rpcUrl, "--dir", unfunded]);
  assert.equal(tooEarly.json.ok, false);
  assert.equal(tooEarly.json.code, "ORDER_NOT_FOUND");
  assert.equal(tooEarly.json.retryable, true);
  assert.equal(existsSync(join(unfunded, "provider-submission.json")), false);

  assert.equal(dir.length > 0, true);
});

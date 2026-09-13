import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { runLocalDemo } from "../scripts/local-demo.mjs";

const env = { PROOFORDER_RPC_URL: "http://127.0.0.1:1" };
const name = `test-lifecycle-${process.pid}`;
const reportUrl = new URL(`../artifacts/${name}.json`, import.meta.url);

test("local runner writes success and removes stale evidence when a later flow fails", async () => {
  try {
    const report = await runLocalDemo({ env, reportName: name, flow: async () => ({ status: "passed" }) });
    assert.deepEqual(JSON.parse(await readFile(reportUrl, "utf8")), report);
    assert.match(report.nodeLifecycle, /user-supplied/);
    await assert.rejects(runLocalDemo({ env, reportName: name, flow: async () => { throw new Error("RPC failed"); } }), /RPC failed/);
    await assert.rejects(access(reportUrl), { code: "ENOENT" });
  } finally {
    await rm(reportUrl, { force: true });
  }
});

test("local runner timeout and pre-aborted input fail without publishing success", async () => {
  let aborted = false;
  await assert.rejects(runLocalDemo({
    env, reportName: name, timeoutMs: 250,
    flow: async (url, { signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve({ status: "passed" }); }, { once: true });
    }),
  }), /exceeded 250 ms/);
  assert.equal(aborted, true);
  const controller = new AbortController();
  controller.abort(new Error("cancelled before launch"));
  await assert.rejects(runLocalDemo({ env, reportName: name, signal: controller.signal,
    flow: async () => assert.fail("Cancelled flow must not run"),
  }), /cancelled before launch/);
  await assert.rejects(access(reportUrl), { code: "ENOENT" });
});

test("local runner refuses a remote endpoint before invoking the flow", async () => {
  await assert.rejects(runLocalDemo({ env: { PROOFORDER_RPC_URL: "https://example.com" }, reportName: name,
    flow: async () => assert.fail("Remote flow must not run"),
  }), /dedicated local Anvil/);
});

test("SIGINT handling stops an owned Anvil and leaves no success report", { timeout: 15_000 }, async () => {
  // Exercise signal handling in another process so it cannot interrupt the test runner.
  const script = `
    import { runLocalDemo } from ${JSON.stringify(new URL("../scripts/local-demo.mjs", import.meta.url).href)};
    let url;
    try {
      await runLocalDemo({ env: {}, reportName: ${JSON.stringify(name)}, flow: async (rpcUrl, {signal}) => {
        url = rpcUrl;
        // Windows cannot deliver a catchable self-SIGINT to Node's handler.
        if (process.platform === 'win32') process.emit('SIGINT');
        else process.kill(process.pid, 'SIGINT');
        return await new Promise(resolve => signal.addEventListener('abort', () => resolve({status:'passed'}), {once:true}));
      }});
      throw new Error('Unexpected success');
    } catch (error) {
      if (!/interrupted/.test(error.message)) throw error;
    }
    let reachable = false;
    try { await fetch(url, {signal:AbortSignal.timeout(500)}); reachable = true; } catch {}
    console.log(JSON.stringify({reachable}));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 12_000 });
  assert.deepEqual(JSON.parse(stdout), { reachable: false });
  await assert.rejects(access(reportUrl), { code: "ENOENT" });
});

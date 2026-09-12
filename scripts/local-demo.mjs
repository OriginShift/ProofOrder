import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const rootUrl = new URL("../", import.meta.url);
const artifactsUrl = new URL("../artifacts/", import.meta.url);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function checkLocalUrl(rpcUrl) {
  const url = new URL(rpcUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Demos require a dedicated local Anvil HTTP endpoint");
  }
}

async function waitForAnvil(rpcUrl, childState, signal) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (childState.ended) {
      throw new Error(`Anvil exited before readiness: ${childState.error?.message ?? childState.output}`);
    }
    try {
      const response = await fetch(rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(500)]),
      });
      const payload = await response.json();
      if (response.ok && /anvil/i.test(payload.result ?? "")) return;
    } catch {
      // Connection refusal is expected while the owned node starts.
    }
    await delay(100, undefined, { signal });
  }
  throw new Error(`Anvil did not become ready within 10 seconds: ${childState.output}`);
}

async function stopChild(child, state) {
  if (!child || state.ended) return;
  child.kill("SIGTERM");
  await Promise.race([state.promise, delay(2_000, undefined, { ref: false })]);
  if (state.ended) return;
  child.kill("SIGKILL");
  await Promise.race([state.promise, delay(2_000, undefined, { ref: false })]);
  if (!state.ended) throw new Error("Owned Anvil did not exit after SIGKILL");
}

async function writeReport(reportUrl, reportName, report, signal) {
  const tempUrl = new URL(`.${reportName}.${process.pid}.tmp`, artifactsUrl);
  try {
    await mkdir(artifactsUrl, { recursive: true });
    await writeFile(tempUrl, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", signal });
    signal.throwIfAborted();
    await rename(tempUrl, reportUrl);
  } finally {
    await rm(tempUrl, { force: true });
  }
}

// Flows must release their own RPC clients when the supplied signal aborts.
export async function runLocalDemo({ flow, reportName, timeoutMs = 120_000, env = process.env, signal }) {
  if (typeof flow !== "function") throw new TypeError("runLocalDemo requires a flow function");
  if (!reportName || !/^[a-z0-9][a-z0-9-]*$/.test(reportName)) throw new TypeError("Invalid report name");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid demo timeout");

  const controller = new AbortController();
  const reportUrl = new URL(`${reportName}.json`, artifactsUrl);
  let child;
  let childState;
  const interrupt = () => controller.abort(new Error(`${reportName} interrupted; transaction outcome may be unknown`));
  const relayAbort = () => controller.abort(signal.reason ?? new Error(`${reportName} interrupted`));
  let rejectCancelled;
  const cancelled = new Promise((resolve, reject) => { rejectCancelled = reject; });
  const onAbort = () => rejectCancelled(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  signal?.addEventListener("abort", relayAbort, { once: true });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(() => controller.abort(new Error(`${reportName} exceeded ${timeoutMs} ms; transaction outcome may be unknown`)), timeoutMs);

  const execute = async () => {
    controller.signal.throwIfAborted();
    await rm(reportUrl, { force: true });
    controller.signal.throwIfAborted();
    let rpcUrl = env.PROOFORDER_RPC_URL;
    if (rpcUrl) {
      checkLocalUrl(rpcUrl);
    } else {
      const port = await freePort();
      controller.signal.throwIfAborted();
      rpcUrl = `http://127.0.0.1:${port}`;
      childState = { ended: false, output: "", error: undefined };
      child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--quiet"], {
        cwd: rootUrl, stdio: ["ignore", "pipe", "pipe"],
      });
      childState.promise = new Promise((resolve) => {
        child.once("error", (error) => { childState.error = error; childState.ended = true; resolve(); });
        child.once("exit", () => { childState.ended = true; resolve(); });
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (data) => { childState.output = (childState.output + data.toString()).slice(-4_000); });
      }
      await waitForAnvil(rpcUrl, childState, controller.signal);
    }
    controller.signal.throwIfAborted();
    const report = await flow(rpcUrl, { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!report || typeof report !== "object" || Array.isArray(report)) throw new TypeError(`${reportName} flow must return an object report`);
    return { ...report, nodeLifecycle: child
      ? "fresh Anvil started and stopped by runner"
      : "user-supplied local Anvil; not stopped or reset by runner" };
  };

  try {
    if (signal?.aborted) relayAbort();
    const report = await Promise.race([execute(), cancelled]);
    await stopChild(child, childState);
    controller.signal.throwIfAborted();
    await writeReport(reportUrl, reportName, report, controller.signal);
    controller.signal.throwIfAborted();
    return report;
  } catch (error) {
    await rm(reportUrl, { force: true });
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    try {
      await stopChild(child, childState);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", relayAbort);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

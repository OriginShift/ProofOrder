import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { runFailureFlow } from "../src/failure-flow.mjs";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

let child;
let childDone;
let childEnded = false;
let childError;
let anvilOutput = "";
const stopOwnedNode = () => child?.kill("SIGTERM");
const controller = new AbortController();
const interrupt = () => {
  controller.abort(new Error("Failure demo interrupted; transaction outcome may be unknown"));
  stopOwnedNode();
  process.exitCode = 130;
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  await rm(new URL("../artifacts/failure-boundaries.json", import.meta.url), { force: true });
  let rpcUrl = process.env.PROOFORDER_RPC_URL;
  if (!rpcUrl) {
    const port = await freePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
    childDone = new Promise((resolve) => {
      child.once("error", (error) => { childError = error; childEnded = true; resolve(); });
      child.once("exit", () => { childEnded = true; resolve(); });
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (data) => { anvilOutput = (anvilOutput + data.toString()).slice(-4000); });
    }
    const readyDeadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      controller.signal.throwIfAborted();
      if (childEnded) throw new Error(`Anvil exited before readiness: ${childError?.message ?? anvilOutput}`);
      try {
        const response = await fetch(rpcUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(500)]),
        });
        const payload = await response.json();
        if (response.ok && /anvil/i.test(payload.result ?? "")) {
          ready = true;
          break;
        }
      } catch {
        // Connection refusal is expected while the owned node starts.
      }
      await delay(100);
    }
    if (!ready) throw new Error(`Anvil did not become ready within 10 seconds: ${anvilOutput}`);
  }
  const report = await runFailureFlow(rpcUrl, { signal: controller.signal });
  report.nodeLifecycle = child ? "fresh Anvil started and stopped by runner" : "user-supplied local Anvil; not stopped or reset by runner";
  await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
  await writeFile(new URL("../artifacts/failure-boundaries.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`Failure demo failed: ${error.stack ?? error}`);
  process.exitCode ||= 1;
} finally {
  if (child) {
    stopOwnedNode();
    await Promise.race([childDone, delay(2_000, undefined, { ref: false })]);
    if (!childEnded) {
      child.kill("SIGKILL");
      await childDone;
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}

import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { Interface } from "ethers";
import { expectContractError, runFailureFlow } from "../src/failure-flow.mjs";

const abi = new Interface(["error InvalidSignature()", "error InvalidOrder()"]);
const rejectsWith = (error) => async () => { throw error; };

test("failure assertion accepts only the expected decoded contract error", async () => {
  const data = abi.encodeErrorResult("InvalidSignature");
  assert.deepEqual(await expectContractError(rejectsWith({ code: "CALL_EXCEPTION", data }), abi, "InvalidSignature"), {
    error: "InvalidSignature", revertData: data,
  });
});

test("RPC errors, wrong reverts, missing data and successful calls cannot pass a rejection check", async () => {
  for (const failure of [
    { code: "NETWORK_ERROR", data: abi.encodeErrorResult("InvalidSignature") },
    { code: "CALL_EXCEPTION", data: abi.encodeErrorResult("InvalidOrder") },
    { code: "CALL_EXCEPTION", data: null },
    { code: "CALL_EXCEPTION", data: "0xdeadbeef" },
    new Error("signing failed"),
  ]) {
    await assert.rejects(expectContractError(rejectsWith(failure), abi, "InvalidSignature"));
  }
  await assert.rejects(expectContractError(async () => {}, abi, "InvalidSignature"), /call succeeded/);
});

test("failure flow rejects nonlocal endpoints before opening RPC", async () => {
  for (const url of ["https://example.com", "http://example.com", "https://localhost:8545"]) {
    await assert.rejects(runFailureFlow(url), /dedicated local Anvil/);
  }
});

test("unresponsive RPC fails on the overall deadline and supports interruption", { timeout: 3_000 }, async () => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(runFailureFlow(url, { timeoutMs: 30 }), /exceeded 30 ms/);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("test interruption")), 30);
    try {
      await assert.rejects(runFailureFlow(url, { signal: controller.signal }), /test interruption/);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

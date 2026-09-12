import { runFailureFlow } from "../src/failure-flow.mjs";
import { runLocalDemo } from "./local-demo.mjs";

try {
  const report = await runLocalDemo({ flow: runFailureFlow, reportName: "failure-boundaries" });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`Failure demo failed: ${error.stack ?? error}`);
  process.exitCode = error?.message?.includes("interrupted") ? 130 : 1;
}

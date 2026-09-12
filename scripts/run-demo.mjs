import { runDemoFlow } from "../src/demo-flow.mjs";
import { runLocalDemo } from "./local-demo.mjs";

try {
  const report = await runLocalDemo({ flow: runDemoFlow, reportName: "encrypted-delivery" });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`Demo failed: ${error.stack ?? error}`);
  process.exitCode = error?.message?.includes("interrupted") ? 130 : 1;
}

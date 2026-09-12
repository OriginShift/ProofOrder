import { runPaymentGatedFlow } from "../src/payment-gated-flow.mjs";
import { runLocalDemo } from "./local-demo.mjs";

try {
  const report = await runLocalDemo({ flow: runPaymentGatedFlow, reportName: "payment-gated-disclosure" });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`Deferred-key experiment failed: ${error.stack ?? error}`);
  process.exitCode = error?.message?.includes("interrupted") ? 130 : 1;
}

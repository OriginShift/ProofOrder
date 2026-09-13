// Fixed CLI fixture for the buyer/provider/verifier workflow.
//
// These are the same demo parameters as the recorded local demo: a 10,000 minor-unit budget split
// 6,000/4,000 across two snapshot targets. They are demo data, not a real procurement dataset, and
// the CLI reports them as such.
export function fixedSnapshot() {
  return {
    id: "fixed-snapshot-001",
    targets: [
      { id: "target-a", liquidityBps: 9000, scoreBps: 8200 },
      { id: "target-b", liquidityBps: 8000, scoreBps: 7600 },
    ],
  };
}

export function fixedAllocations() {
  return [
    { target: "target-a", amountMinorUnits: 6000 },
    { target: "target-b", amountMinorUnits: 4000 },
  ];
}

export const FIXTURE_DISCLOSURE =
  "Demo fixture only: fixed snapshot metrics and allocations used to exercise the frozen rule. Not a real procurement dataset and not evidence of a credible purchasing example.";

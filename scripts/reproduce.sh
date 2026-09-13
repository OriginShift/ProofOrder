#!/usr/bin/env bash
# Reproduces the bounded ProofOrder CLI delivery in this worktree.
#
#   bash scripts/reproduce.sh
#
# It writes one timestamped log under delivery-logs/ and exits non-zero if any step fails.
# Foundry (forge/anvil) must be installed; the script picks it up from PATH or ~/.foundry/bin.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="${HOME}/.foundry/bin:${PATH}"
mkdir -p delivery-logs
LOG="delivery-logs/reproduce-$(date -u +%Y%m%dT%H%M%SZ).log"

{
  echo "# ProofOrder reproduction"
  echo "# cwd: $(pwd)"
  echo "# date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node --version)"
  echo "# npm: $(npm --version)"
  echo "# forge: $(forge --version)"
  echo "# anvil: $(anvil --version)"

  echo
  echo "== forge build =="
  forge build

  echo
  echo "== forge test -vv (baseline 24 + adversarial) =="
  forge test -vv

  echo
  echo "== npm test (JS units + separate-process CLI end-to-end harness) =="
  npm test

  echo
  echo "== npm audit =="
  npm audit || echo "npm audit reported findings (see above)"

  echo
  echo "== CLI end-to-end harness alone =="
  node --test test/cli-workflow.test.mjs

  echo
  echo "== npm run demo (encrypted delivery / exchange boundary) =="
  npm run demo

  echo
  echo "== npm run demo:failures =="
  npm run demo:failures

  echo
  echo "== done =="
} 2>&1 | tee "$LOG"

echo "log: $LOG"

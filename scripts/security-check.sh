#!/usr/bin/env bash
# Offline security checks, no AWS credentials needed (also run by .github/workflows/security.yml):
#   1. npm audit (high/critical fail) for mcp-server and infra
#   2. MCP server type check + tests
#   3. infra type check + tests: synthesizes the stacks with a dummy account and runs cdk-nag (AwsSolutions)
#
#   scripts/security-check.sh            # install dependencies with npm ci first
#   scripts/security-check.sh --no-install
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL=true
[ "${1:-}" = "--no-install" ] && INSTALL=false

for d in mcp-server infra; do
  echo "==> $d"
  cd "$ROOT/$d"
  $INSTALL && npm ci --no-audit --no-fund --loglevel=error
  npm audit --audit-level=high
  npx tsc --noEmit
  npm test
done
echo "Security checks passed"

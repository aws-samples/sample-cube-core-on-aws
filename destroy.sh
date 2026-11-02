#!/usr/bin/env bash
# Deletes the Cube on AWS stacks. In "prod" environment, data buckets, the KMS key,
# secrets and log groups are RETAINED and must be removed manually.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$ROOT/config.json" ] || cp "$ROOT/config.example.json" "$ROOT/config.json"
cfg() { node -e "const d=require('$ROOT/config.example.json');const u=require('$ROOT/config.json');const v=(u$1!==undefined?u$1:d$1);process.stdout.write(String(v??''))"; }
STACK=$(cfg ".stackName"); REGION=$(cfg ".region")
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_ACCOUNT="$ACCOUNT" CDK_DEFAULT_REGION="$REGION" AWS_REGION="$REGION"
read -r -p "Destroy stacks $STACK and $STACK-Waf in $ACCOUNT/$REGION? Type the stack name to confirm: " ans
[ "$ans" = "$STACK" ] || { echo "Aborted."; exit 1; }
[ -d "$ROOT/infra/node_modules" ] || (cd "$ROOT/infra" && npm ci --no-audit --no-fund --loglevel=error)
[ -d "$ROOT/mcp-server/node_modules" ] || (cd "$ROOT/mcp-server" && npm ci --no-audit --no-fund --loglevel=error)
cd "$ROOT/infra" && npx cdk destroy --all --force

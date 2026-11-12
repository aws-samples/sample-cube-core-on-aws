#!/usr/bin/env bash
# One-command deployment of Cube Core on AWS.
#   ./deploy.sh                 # uses config.json (created from config.example.json on first run)
#   ./deploy.sh --yes           # non-interactive (CI)
#   AWS_PROFILE=prod ./deploy.sh
# Security services (default on, see README 7.8); these flags override config.json "security":
#   --no-waf  --no-cloudtrail  --no-guardduty  --no-vpc-flow-logs
#   --skip-audit                # do not stop on high/critical npm audit findings
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YES=false
SKIP_AUDIT=false
CTX=()
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=true ;;
    --no-waf) CTX+=(-c security.waf=false) ;;
    --no-cloudtrail) CTX+=(-c security.cloudTrail=false) ;;
    --no-guardduty) CTX+=(-c security.guardDuty=false) ;;
    --no-vpc-flow-logs) CTX+=(-c security.vpcFlowLogs=false) ;;
    --skip-audit) SKIP_AUDIT=true ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

c_info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
c_ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
c_err()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; }

# ---------- 1. prerequisites
c_info "Checking prerequisites"
command -v node >/dev/null || { c_err "Node.js >= 20 is required (https://nodejs.org)"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { c_err "Node.js >= 20 is required (found $(node -v))"; exit 1; }
command -v aws >/dev/null || { c_err "AWS CLI v2 is required (https://aws.amazon.com/cli/)"; exit 1; }
CALLER=$(aws sts get-caller-identity --output json) || { c_err "AWS credentials are not configured (aws configure / AWS_PROFILE / SSO login)"; exit 1; }
ACCOUNT=$(node -p "JSON.parse(process.argv[1]).Account" "$CALLER")
ARN=$(node -p "JSON.parse(process.argv[1]).Arn" "$CALLER")
c_ok "node $(node -v), $(aws --version 2>&1 | cut -d' ' -f1), identity $ARN"

if [ ! -f "$ROOT/config.json" ]; then
  cp "$ROOT/config.example.json" "$ROOT/config.json"
  c_ok "Created config.json from config.example.json (edit it to customize)"
fi
cfg() { node -e "const d=require('$ROOT/config.example.json');const u=require('$ROOT/config.json');const v=(u$1!==undefined?u$1:d$1);process.stdout.write(String(v??''))" 2>/dev/null || true; }
STACK=$(cfg ".stackName")
REGION=$(cfg ".region")
ENVIRONMENT=$(cfg ".environment")
export CDK_DEFAULT_ACCOUNT="$ACCOUNT" CDK_DEFAULT_REGION="$REGION" AWS_REGION="$REGION"

# Effective security switch: a --no-* flag wins over config.json.
sec() {
  if [[ " ${CTX[*]-} " == *" security.$1=false "* ]]; then echo false; return; fi
  node -e "const d=require('$ROOT/config.example.json');const u=require('$ROOT/config.json');const v=(u.security||{})['$1'];process.stdout.write(String(v ?? d.security['$1']))"
}

# GuardDuty allows one detector per account and Region; creating a second fails the deployment.
# Keep it on only if there is no detector yet, or the existing one belongs to this stack.
if [ "$(sec guardDuty)" = "true" ]; then
  DETECTOR=$(aws guardduty list-detectors --region "$REGION" --query 'DetectorIds[0]' --output text 2>/dev/null || echo None)
  OWNED=$(aws cloudformation list-stack-resources --stack-name "$STACK" --region "$REGION" \
    --query "StackResourceSummaries[?ResourceType=='AWS::GuardDuty::Detector'].PhysicalResourceId" --output text 2>/dev/null || true)
  if [ -n "$DETECTOR" ] && [ "$DETECTOR" != "None" ] && [ "$DETECTOR" != "$OWNED" ]; then
    CTX+=(-c security.guardDuty=false)
    c_ok "GuardDuty is already enabled in $REGION (detector $DETECTOR): using it, the stack will not create one"
  fi
fi
# A second trail never fails, but duplicates management-event charges. Warn only.
if [ "$(sec cloudTrail)" = "true" ]; then
  TRAILS=$(aws cloudtrail describe-trails --region "$REGION" --query "trailList[?IsMultiRegionTrail && !starts_with(Name, '$STACK-')].Name" --output text 2>/dev/null || true)
  if [ -n "$TRAILS" ]; then
    echo "  ! A multi-Region CloudTrail trail already exists ($TRAILS). The stack adds its own trail;" \
      "management events beyond the first copy are billed. Use --no-cloudtrail to skip it."
  fi
fi

echo
echo "  Account     : $ACCOUNT"
echo "  Region      : $REGION"
echo "  Stack       : $STACK  ($ENVIRONMENT)"
echo "  Security    : WAF=$(sec waf) CloudTrail=$(sec cloudTrail) GuardDuty=$(sec guardDuty) VPCFlowLogs=$(sec vpcFlowLogs)"
echo
if ! $YES; then
  read -r -p "Deploy Cube Core to this account? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# ---------- 2. dependencies
c_info "Installing dependencies"
(cd "$ROOT/mcp-server" && npm ci --no-audit --no-fund --loglevel=error && npm test --silent >/dev/null && npm run build --silent >/dev/null)
(cd "$ROOT/infra" && npm ci --no-audit --no-fund --loglevel=error)
c_ok "Dependencies installed, MCP server tests passed"

# Dependency vulnerability scan (packages that are deployed or run the deployment).
if ! $SKIP_AUDIT; then
  for d in mcp-server infra; do
    (cd "$ROOT/$d" && npm audit --omit=dev --audit-level=high) \
      || { c_err "npm audit found high/critical vulnerabilities in $d (update dependencies, or re-run with --skip-audit)"; exit 1; }
  done
  c_ok "npm audit: no high/critical vulnerabilities"
fi

CDK="$ROOT/infra/node_modules/.bin/cdk"

# ---------- 3. bootstrap (idempotent)
BOOTSTRAP_REGIONS="$REGION"
[ "$(sec waf)" = "true" ] && BOOTSTRAP_REGIONS="$BOOTSTRAP_REGIONS us-east-1"  # CloudFront WAF lives in us-east-1
for r in $(printf '%s\n' $BOOTSTRAP_REGIONS | sort -u); do
  if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region "$r" >/dev/null 2>&1; then
    c_info "Bootstrapping CDK in $ACCOUNT/$r"
    (cd "$ROOT/infra" && "$CDK" bootstrap "aws://$ACCOUNT/$r")
  fi
done

# ---------- 4. synth (runs cdk-nag AwsSolutions checks) + deploy
c_info "Synthesizing and running cdk-nag security checks"
(cd "$ROOT/infra" && "$CDK" synth --quiet ${CTX[@]+"${CTX[@]}"} >/dev/null)
c_ok "cdk-nag checks passed"

c_info "Deploying (first deployment takes ~15-20 minutes)"
OUTPUTS="$ROOT/infra/cdk-outputs.json"
(cd "$ROOT/infra" && "$CDK" deploy --all ${CTX[@]+"${CTX[@]}"} --require-approval never --outputs-file "$OUTPUTS" --progress events)

out() { node -p "(require('$OUTPUTS')['$STACK']||{})['$1']||''"; }
CUBE_URL=$(out CubeUrl)
MCP_URL=$(out McpUrl)
SECRET_ARN=$(out ApiSecretArn)

# ---------- 5. smoke test
c_info "Running smoke test"
TOKEN=$(node "$ROOT/scripts/gen-token.mjs" --secret-arn "$SECRET_ARN" --region "$REGION" --expires-in 1h --quiet)
SMOKE_RC=0
if "$ROOT/scripts/smoke-test.sh" "$CUBE_URL" "$TOKEN"; then c_ok "Smoke test passed"; else SMOKE_RC=1; c_err "Smoke test failed (see above). The stack is deployed; check CloudWatch logs."; fi

cat <<MSG

──────────────────────────────────────────────────────────────
 Cube Core is running on AWS 🎉

 REST API : $CUBE_URL/cubejs-api/v1
 MCP      : ${MCP_URL:-disabled}

 Issue a token (default 24h):
   node scripts/gen-token.mjs --stack $STACK --region $REGION

 Query:
   curl -H "Authorization: \$TOKEN" "$CUBE_URL/cubejs-api/v1/meta"

 Add the MCP server to Claude Code:
   claude mcp add --transport http cube $MCP_URL --header "Authorization: Bearer \$TOKEN"
──────────────────────────────────────────────────────────────
MSG
exit $SMOKE_RC

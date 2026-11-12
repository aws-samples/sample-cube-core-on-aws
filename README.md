# Cube Core on AWS

Deploy [Cube Core](https://github.com/cube-js/cube) (open-source semantic layer) into your own AWS account with a single **AWS CDK** command, using an architecture designed around AWS security best practices.

[中文文档](README.zh-CN.md)

What gets deployed:

- **Cube API**: REST API, plus an optional Postgres-protocol SQL API.
- **Refresh Worker**: builds pre-aggregations in the background.
- **Cube Store cluster**: pre-aggregation storage, cache, and queue.
- **Remote MCP Server**: AI agents such as Claude and Cursor can query data directly through the semantic layer.
- **Demo data source (optional)**: Athena plus a sample dataset, queryable right after deployment.

> **Important:** This is sample code for demonstration and educational purposes only. It is not intended for production use without your own review, testing, and hardening. You are responsible for the security, compliance, and cost of any AWS resources you deploy. Deploying this sample creates billable resources (see [Cost](#9-cost-estimate)).

```bash
git clone https://github.com/aws-samples/sample-cube-core-on-aws.git && cd sample-cube-core-on-aws
./deploy.sh
```

> Currently pinned Cube version: `v1.8.13` (`config.json` → `cubeVersion`).

---

## Table of contents

0. [When to choose Cube Core](#0-when-to-choose-cube-core)
1. [Architecture](#1-architecture)
2. [Quick start](#2-quick-start)
3. [Using Cube: REST API / token / SQL API](#3-using-cube)
4. [MCP: connecting AI agents](#4-mcp-connecting-ai-agents)
5. [Bring your own data source and data model](#5-bring-your-own-data-source-and-data-model)
6. [Configuration reference (config.json)](#6-configuration-reference-configjson)
7. [Security design (AWS best practices)](#7-security-design-aws-best-practices)
8. [Operations: upgrades, scaling, logs, alarms, secret rotation](#8-operations)
9. [Cost estimate](#9-cost-estimate)
10. [Troubleshooting](#10-troubleshooting)
11. [Cleanup](#11-cleanup)
12. [Project structure](#12-project-structure)

---

## 0. When to choose Cube Core

### 0.1 What problem Cube solves

Cube is a **semantic layer**. It sits between your data warehouse or database and the consumers of the data: BI tools, embedded analytics, application backends, and AI agents.

Metric definitions (for example "GMV", "active users", "repeat purchase rate"), joins, dimensions, and access rules are **defined once, in Cube's data model (YAML/JS)**. Every consumer gets results through Cube's APIs instead of writing its own SQL.

| Common pain point | How Cube addresses it |
|---|---|
| The same metric comes out different in different reports and teams | Metrics are defined centrally and versioned (model files live in Git) |
| Front ends or apps query the warehouse directly: slow, expensive, and concurrency-limited | **Pre-aggregations**: Cube Store precomputes results and returns them in sub-second time; query caching and queuing also protect the warehouse |
| Multi-tenant SaaS needs per-customer data isolation | JWT `securityContext` plus `queryRewrite` enforce row-level security in the semantic layer |
| Every type of consumer needs its own integration | One model serves REST, GraphQL, the Postgres-protocol SQL API, and this sample's MCP server |
| Letting an LLM write SQL directly is inaccurate and unsafe | Agents can only combine **predefined measures/dimensions**, so definitions stay consistent and access rules still apply (see section 4) |

### 0.2 Good fits for Cube Core

- **Embedded analytics / customer-facing data products**: reports and dashboards shown to customers inside a SaaS app, with low latency, high concurrency, and per-tenant isolation. This is Cube's most typical use case.
- **Governed data access for AI agents / chat BI**: agents query through the semantic layer via MCP or REST instead of connecting to the database and writing SQL.
- **Several BI tools and apps sharing one set of metrics**: Tableau, Superset, Metabase, custom front ends, and so on.
- **Expensive or slow warehouse queries**: Athena bills by data scanned; Redshift and Snowflake have limited concurrency. Pre-aggregations keep high-frequency queries off the warehouse.
- **Self-hosting required**: data must not leave your AWS account, you have compliance or data-residency requirements, or you want Apache-2.0 open-source components and no vendor lock-in.

### 0.3 Less suitable scenarios

| Scenario | Better choice |
|---|---|
| One BI tool, few reports, simple metric definitions | Amazon QuickSight connected to Athena or Redshift, with SPICE |
| Mostly data scientists doing exploratory, ad hoc, complex SQL | Athena, Redshift Query Editor, or notebooks directly. A semantic layer limits flexibility |
| Row-level ETL or data transformation | Glue, dbt, EMR, etc. Cube is not an ETL tool; it assumes the data is already modeled in the warehouse |
| The team does not want to operate any infrastructure | Cube Cloud (managed), see the table below |
| Heavy dbt Cloud users with all metrics defined in dbt | Evaluate the dbt Semantic Layer first. Cube can also read dbt models; the two are not mutually exclusive |

### 0.4 Cube Core (this sample) vs. Cube Cloud

| | **Cube Core on AWS (this sample)** | **Cube Cloud** |
|---|---|---|
| License / cost | Apache-2.0 open source; you pay only for AWS resources (dev default about $400/month, see section 9) | Commercial subscription, priced by plan and usage |
| Where data and deployment live | Entirely in your own AWS account and VPC | Hosted by Cube (private options such as BYOC are also available) |
| Semantic layer, APIs, pre-aggregations, Cube Store | ✅ Full | ✅ Full |
| Operations (upgrades, scaling, monitoring) | Your responsibility; this sample simplifies it with CDK and alarms | Managed by Cube |
| Online IDE, model development environment, multiple environments | ❌ Not included. Develop models locally with `cube dev`, manage them in Git, sync on deploy | ✅ |
| Value-added features such as AI, semantic catalog, BI integration sync | ❌ Not included. The bundled MCP server covers the "for AI agents" part | ✅ |
| SSO / user management | Integrate your own IdP (for example Cognito) via JWT or JWKS | ✅ Built in |

**In one sentence**: choose Cube Core on AWS if data must stay in your account, you need embedded analytics or governed data access for agents, and your team can operate AWS resources. Choose Cube Cloud if you want it ready out of the box, with an online IDE and enterprise add-ons.

---

## 1. Architecture

```
                  ┌─────────────────────────── us-east-1 ────────────────────────────┐
                  │  AWS WAF (managed rules + rate limit + optional IP allow list)   │
                  └─────────────────────────────────┬────────────────────────────────┘
 Client / BI / AI Agent                             │
        │  HTTPS                                    ▼
        └──────────────────────────▶  Amazon CloudFront  ──(VPC Origin, AWS network)──┐
                                                                                      │
┌──────────────────────────────── VPC (region of your choice) ────────────────────────┼────────┐
│  Private subnets (no public IPs)                                                    ▼        │
│                                           ┌────── Internal ALB (CloudFront only) ──────┐     │
│                                           │ /cubejs-api/*, /livez, /readyz → Cube API  │     │
│                                           │ /mcp                           → MCP λ     │     │
│                                           │ other paths (Playground, ...)  → 404       │     │
│                                           └───────────┬────────────────────┬───────────┘     │
│                                                       ▼                    ▼                 │
│   ┌─────────────────────── ECS Fargate ────────────────────────┐   ┌───────────────────────┐ │
│   │ Cube API ×N (Auto Scaling)    Cube Refresh Worker ×1       │   │ MCP Server (Lambda)   │ │
│   │   └ init container: S3 → /cube/conf                        │◀──│ forwards caller's     │ │
│   │     (cube.js + model/)                                     │   │ JWT                   │ │
│   │                    │ :3030                                 │   └───────────────────────┘ │
│   │                    ▼                                       │                             │
│   │ Cube Store Router ──:9999/:10001── Cube Store Worker ×N    │  Cloud Map: *.cube.internal │
│   └───────────────────────────┬────────────────────────────────┘                             │
│        VPC Endpoints: S3 / ECR / Logs / Secrets Manager / Athena / Glue                      │
└───────────────────────────────┼──────────────────────────────────────────────────────────────┘
                                ▼
   S3 (KMS): Cube Store data · data model · Athena results · demo data     Secrets Manager (KMS)
   ECR (private mirror, scanned) · CloudWatch Logs (KMS) · Container Insights · SNS alarms
```

| Component | AWS service | Notes |
|---|---|---|
| Entry point | CloudFront + WAF | HTTPS termination, global edge, managed protection rules, per-IP rate limiting |
| Load balancing | **Internal** ALB + CloudFront VPC Origin | The ALB is not exposed to the internet. Its security group only allows the CloudFront origin-facing prefix list |
| Cube API | ECS Fargate service | Auto scales on CPU / memory / request count; rolling deployments with automatic rollback on failure |
| Refresh Worker | ECS Fargate service | Builds and refreshes pre-aggregations (`CUBEJS_REFRESH_WORKER=true`) |
| Cube Store | ECS Fargate: 1 router + N workers | Each node has a fixed Cloud Map DNS name. Persistent data goes to S3 (task role, no static keys) |
| Data model | S3 + init container | The `./cube` directory is uploaded on deploy and synced at container start; content changes trigger a rolling update. **No image build and no Docker needed** |
| Images | Private ECR | Copied from Docker Hub / ECR Public into private ECR at deploy time; scanned on push, immutable tags |
| MCP | Lambda (Node.js 22, ARM64) | Streamable HTTP, stateless. Served under the ALB at `/mcp` |
| Demo data | S3 + Glue + Athena | 6000 rows of synthetic order data, dedicated workgroup, encrypted results |

---

## 2. Quick start

### 2.1 Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | Runs CDK and the scripts |
| AWS CLI | v2 | Credentials configured (`aws configure` / `AWS_PROFILE` / `aws sso login`) |
| IAM permissions | Administrator or equivalent | The first run needs `cdk bootstrap`; the stack creates IAM roles, VPC, ECS, and other resources |
| Docker | **Not required** | Images are copied to ECR by a Lambda function during deployment; Lambda code is bundled with esbuild |

Check your account quotas: fewer than 5 VPCs in the target region (the default limit), and Elastic IPs still available.

### 2.2 Deploy

```bash
./deploy.sh            # deploy after interactive confirmation
./deploy.sh --yes      # CI / non-interactive
AWS_PROFILE=prod ./deploy.sh
./deploy.sh --no-waf --no-guardduty   # turn off paid security services (see 7.8)
```

The script runs these steps:

1. Checks Node, the AWS CLI, and the current identity; on first run it creates `config.json` from `config.example.json`.
2. Installs dependencies, runs the MCP server unit tests, and builds it. Runs `npm audit --omit=dev --audit-level=high` for both packages and stops on high/critical findings (`--skip-audit` to bypass).
3. Runs `cdk bootstrap` as needed in the target region and, when WAF is on, in `us-east-1` (the WAF for CloudFront must live there).
4. `cdk synth`: also runs the **cdk-nag AwsSolutions** security checks and aborts if there are unsuppressed findings.
5. `cdk deploy --all`: deploys `<stackName>-Waf` (us-east-1, when WAF is on) first, then the main stack `<stackName>`. The first deployment takes about 15–20 minutes.
6. Smoke test: health check, unauthenticated request rejected, Playground not reachable, metadata and query working, MCP working.

To change the region, sizing, or data source before deploying, edit `config.json` (fields in [section 6](#6-configuration-reference-configjson)). Minimal example:

```json
{
  "stackName": "CubeCore",
  "region": "ap-northeast-1",
  "environment": "dev"
}
```

Any field you omit uses the default from `config.example.json`.

### 2.3 After deployment

The terminal prints:

```
 REST API : https://dxxxxxxxx.cloudfront.net/cubejs-api/v1
 MCP      : https://dxxxxxxxx.cloudfront.net/mcp
```

Issue a token and query:

```bash
TOKEN=$(node scripts/gen-token.mjs --quiet)
URL=https://dxxxxxxxx.cloudfront.net

curl -s -H "Authorization: $TOKEN" "$URL/cubejs-api/v1/meta" | jq '.cubes[].name'

curl -s -G -H "Authorization: $TOKEN" "$URL/cubejs-api/v1/load" \
  --data-urlencode 'query={"measures":["orders_view.total_amount"],"dimensions":["orders_view.product_category"],"order":{"orders_view.total_amount":"desc"}}' | jq '.data'
```

### 2.4 Test record

This sample was deployed end-to-end on 2026-10-27 in `ap-northeast-1` (WAF in `us-east-1`) and verified with the smoke test (`scripts/smoke-test.sh`) run by `deploy.sh` plus manual tests:

| Test | Result |
|---|---|
| `cdk synth` with cdk-nag AwsSolutions checks | ✅ No unsuppressed findings |
| Fresh deployment (WAF stack + main stack, 157 resources) | ✅ About 18 minutes; redeploy after a data-model-only change about 7 minutes |
| `/readyz` health check (via CloudFront → VPC Origin → internal ALB) | ✅ 200 |
| API request without a token | ✅ 403 |
| Playground (`/`) and unknown paths | ✅ 404, not exposed |
| Plain HTTP request | ✅ Rejected by CloudFront (HTTPS only) |
| `/meta` reads the model | ✅ `orders`, `orders_view` |
| Athena query `orders.count` | ✅ 6000 |
| Month × category query hits a pre-aggregation (confirms the Cube Store cluster and S3 storage work) | ✅ `usedPreAggregations: orders_daily_by_category_region` |
| MCP: `tools/list`, `cube_list_models`, `cube_query` | ✅ |
| MCP without a token | ✅ 401 |
| MCP server unit tests (`npm test`) | ✅ 4/4 |

**Not yet tested** (implemented in configuration, but not run end-to-end): custom data sources (Redshift/RDS/Snowflake), JWKS/Cognito authentication, SQL API (NLB), custom domain, `environment: prod` mode, deploying into an existing VPC. Validate these in dev mode in your own environment first.

---

## 3. Using Cube

### 3.1 Authentication model

Every Cube API request must carry a JWT (`Authorization: <token>`, or `Bearer <token>`). This sample supports two modes:

| Mode | Configuration | Use case |
|---|---|---|
| **HS256 shared secret** (default) | A 64-character random alphanumeric secret is generated at deploy time and stored in Secrets Manager (KMS-encrypted) | Server-side token issuance, for example your backend, a BI gateway, or MCP clients |
| **External IdP / JWKS** | `cube.jwt.jwkUrl` / `issuer` / `audience` | Enterprise SSO, for example Amazon Cognito, Okta, Auth0, Entra ID |

Issue tokens (`scripts/gen-token.mjs`):

```bash
node scripts/gen-token.mjs                                # default 24 hours
node scripts/gen-token.mjs --expires-in 7d                # maximum 90d
node scripts/gen-token.mjs --claims '{"region":"Europe"}' # custom securityContext (row-level security)
node scripts/gen-token.mjs --stack CubeCore --region ap-northeast-1 --quiet
```

The identity running the script needs `cloudformation:DescribeStacks` (to look up the `ApiSecretArn` output, unless you pass `--secret-arn`), `secretsmanager:GetSecretValue` (on that secret), and `kms:Decrypt` (on the stack's CMK). **Never ship the API secret to a front end or client**; issue short-lived tokens on the server side only.

When `cube.jwt.jwkUrl` is set, Cube verifies tokens against your IdP's JWKS, so HS256 tokens from `gen-token.mjs` are not expected to be accepted. This includes the token that `deploy.sh` uses for its smoke test.

Example with Amazon Cognito:

```json
"cube": {
  "jwt": {
    "jwkUrl": "https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/jwks.json",
    "issuer": "https://cognito-idp.<region>.amazonaws.com/<userPoolId>",
    "audience": "<app client id>",
    "algorithms": "RS256",
    "claimsNamespace": ""
  }
}
```

### 3.2 Row-level security (multi-tenancy)

The JWT claims become Cube's `securityContext`. Use `queryRewrite` in `cube/cube.js` to enforce extra filters; an example is already there in the comments:

```js
queryRewrite: (query, { securityContext }) => {
  if (securityContext.region) {
    query.filters.push({ member: 'orders.region', operator: 'equals', values: [securityContext.region] });
  }
  return query;
},
```

If you use `queryRewrite`, also configure `scheduledRefreshContexts` so the Refresh Worker can build pre-aggregations for every tenant.

### 3.3 Common REST API endpoints

| Endpoint | Description |
|---|---|
| `GET /cubejs-api/v1/meta` | Data model metadata |
| `GET/POST /cubejs-api/v1/load` | Run a query (may return `{"error":"Continue wait"}`; retry) |
| `POST /cubejs-api/v1/sql` | Show the SQL Cube generates |
| `GET /readyz`, `/livez` | Health checks (no authentication) |

For the front-end SDK (`@cubejs-client/core`), set `apiUrl` to `https://<CubeUrl>/cubejs-api/v1`.

### 3.4 SQL API (optional, for BI tools)

Cube's SQL API speaks the Postgres protocol, so Tableau, Superset, Metabase, Power BI, and others can connect directly. To enable it:

```json
"sqlApi": { "enabled": true, "allowedCidrs": ["10.0.0.0/8"] }
```

This creates an **internal NLB** (port 15432) whose security group only allows `allowedCidrs`. A username and password are generated and stored in Secrets Manager (output `SqlApiSecretArn`). The port is reachable only from inside the VPC, peered VPCs, VPN, or Direct Connect, and is **not exposed to the internet**.

```bash
aws secretsmanager get-secret-value --secret-id <SqlApiSecretArn> --query SecretString --output text
psql "host=<SqlApiEndpoint hostname> port=15432 user=cube dbname=db"
```

---

## 4. MCP: connecting AI agents

This sample includes an [MCP](https://modelcontextprotocol.io) server (`mcp-server/`) so AI agents can query data safely through the Cube semantic layer instead of writing SQL against the database. Benefits: consistent metric definitions, row-level security still applies, and queries can hit pre-aggregations.

### 4.1 Tools

| Tool | Purpose |
|---|---|
| `cube_list_models` | List cubes / views with their measures, dimensions, and segments |
| `cube_describe_model` | Full metadata for one cube or view (types, descriptions, formats) |
| `cube_query` | Run a Cube JSON query (handles `Continue wait` retries automatically; default `limit` 100, returns at most 500 rows) |
| `cube_generate_sql` | Validate a query and return the SQL Cube would run (without running it) |

All tools are annotated with `readOnlyHint` and are read-only.

### 4.2 Remote MCP (deployed on AWS, recommended)

Endpoint: `https://<CubeUrl>/mcp` (Streamable HTTP, stateless). Authentication: `Authorization: Bearer <Cube JWT>`. The Lambda function **holds no secrets**; it forwards the caller's token to Cube for verification, so each agent's and user's permissions are determined by their own token.

**Claude Code**

```bash
TOKEN=$(node scripts/gen-token.mjs --expires-in 7d --quiet)
claude mcp add --transport http cube https://<CubeUrl>/mcp --header "Authorization: Bearer $TOKEN"
```

**Claude Desktop / Cursor / other HTTP-capable clients** (`mcp.json` / `claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "cube": {
      "type": "http",
      "url": "https://<CubeUrl>/mcp",
      "headers": { "Authorization": "Bearer <CUBE_JWT>" }
    }
  }
}
```

For clients that only support stdio, bridge with `mcp-remote`: `npx mcp-remote https://<CubeUrl>/mcp --header "Authorization: Bearer <CUBE_JWT>"`.

**Amazon Bedrock AgentCore / Strands Agents**: connect a Streamable HTTP client to `https://<CubeUrl>/mcp` with the same header.

### 4.3 Local MCP (stdio)

```bash
cd mcp-server && npm ci && npm run build
```

```json
{
  "mcpServers": {
    "cube": {
      "command": "node",
      "args": ["/absolute/path/to/sample-cube-core-on-aws/mcp-server/dist/stdio.mjs"],
      "env": {
        "CUBE_API_URL": "https://<CubeUrl>",
        "CUBE_API_TOKEN": "<CUBE_JWT>"
      }
    }
  }
}
```

### 4.4 Test with curl

```bash
curl -s -X POST https://<CubeUrl>/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cube_query","arguments":{"measures":["orders_view.count"],"dimensions":["orders_view.region"]}}}' | jq -r '.result.content[0].text'
```

To disable MCP, set `"mcp": { "enabled": false }`. The Lambda function, the `/mcp` ALB rule, the `McpUrl` output, and the MCP alarm are then not created.

---

## 5. Bring your own data source and data model

### 5.1 Data model

The `cube/` directory is Cube's configuration directory, mapped to `/cube/conf` in the containers:

```
cube/
├── cube.js              # Cube configuration (queryRewrite, contextToAppId, etc.)
└── model/
    ├── cubes/*.yml      # cubes
    └── views/*.yml      # views (recommended for BI and AI)
```

After changing it, rerun `./deploy.sh`: the files are uploaded to S3 and CDK triggers an ECS rolling update based on a hash of the directory contents, **with no downtime**.

> If `cube.js` needs npm dependencies (`require('xxx')`) or Python packages, you need a custom image. See [Cube docs · Extend the Docker image](https://cube.dev/docs/product/deployment/core#extend-the-docker-image): push it to your ECR, then change `cubeImage` in `infra/lib/cube-stack.ts`.

### 5.2 Data sources

Set `dataSource.type` to `custom`. Put non-sensitive parameters in `env`. Store passwords and other sensitive values in Secrets Manager first and reference them through `secretEnv` (ECS injects them at start-up, so they never appear in plain text in the task definition).

**Amazon Redshift**

```bash
aws secretsmanager create-secret --name cube/redshift \
  --secret-string '{"username":"cube_ro","password":"..."}'
```

```json
"dataSource": {
  "type": "custom",
  "env": {
    "CUBEJS_DB_TYPE": "redshift",
    "CUBEJS_DB_HOST": "my-cluster.xxxx.ap-northeast-1.redshift.amazonaws.com",
    "CUBEJS_DB_PORT": "5439",
    "CUBEJS_DB_NAME": "analytics",
    "CUBEJS_DB_SSL": "true"
  },
  "secretArn": "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:cube/redshift-AbCdEf",
  "secretEnv": { "CUBEJS_DB_USER": "username", "CUBEJS_DB_PASS": "password" }
}
```

**Amazon RDS / Aurora PostgreSQL**: `CUBEJS_DB_TYPE=postgres`, `CUBEJS_DB_SSL=true`. With an RDS-managed master password secret, set `secretEnv` to `{"CUBEJS_DB_USER":"username","CUBEJS_DB_PASS":"password"}`.

**Snowflake / BigQuery / Databricks / ClickHouse, etc.**: see the [Cube data source docs](https://cube.dev/docs/product/configuration/data-sources) and put the variables in `env` / `secretEnv` the same way.

**Network connectivity**

- Database in the same VPC: set `network.vpcId` to deploy into the existing VPC (it needs private subnets with NAT egress), then allow Cube's security groups (`Cube/ApiSg`, `Cube/RefreshSg`) in the database security group.
- Database in another VPC: use VPC peering or Transit Gateway.
- SaaS data warehouses (Snowflake, BigQuery): traffic goes out through NAT. Add the NAT EIP to the allow list on the other side.

**Recommendation**: give the database account read-only permissions. For large data volumes, configure `CUBEJS_DB_EXPORT_BUCKET` and add the corresponding S3 permissions to the task role; pre-aggregation builds become much faster.

After switching to a custom data source, remove the demo model from `cube/model` (`orders.yml` depends on `CUBE_DEMO_GLUE_DATABASE`, an environment variable that only exists with the Athena demo).

---

## 6. Configuration reference (config.json)

| Field | Default | Description |
|---|---|---|
| `stackName` | `CubeCore` | CloudFormation stack name (the WAF stack is `<stackName>-Waf`) |
| `region` | `us-east-1` | Region of the main stack |
| `environment` | `dev` | `prod` retains S3 buckets, the KMS key, secrets, ECR repositories, and log groups; enables ALB/NLB deletion protection; uses one NAT per AZ (new VPC only); and keeps logs for 1 year |
| `cubeVersion` | `v1.8.13` | Image tag for `cubejs/cube` and `cubejs/cubestore`. **Must be pinned**; `latest` is rejected |
| `network.vpcId` | `""` | If set, deploy into this existing VPC (needs private subnets with egress; the stack then does not create VPC Flow Logs or NAT gateways); otherwise create a new one |
| `network.vpcCidr` | `10.80.0.0/16` | CIDR of the new VPC |
| `network.maxAzs` | `2` | Number of Availability Zones |
| `network.natGateways` | `1` | Number of NAT gateways for a new VPC (automatically ≥ number of AZs in prod) |
| `network.vpcEndpoints` | `true` | Create an S3 gateway endpoint plus interface endpoints for ECR (API and Docker), CloudWatch Logs, and Secrets Manager; Athena and Glue are added only with `athena-demo`. With `vpcId`, set this to `false` if the VPC already has these endpoints |
| `access.allowedCidrs` | `[]` | WAF IP allow list. Empty allows any IP (a valid JWT is still required) |
| `access.rateLimitPer5Min` | `2000` | Request limit per IP per 5 minutes |
| `access.geoAllowList` | `[]` | CloudFront country/region allow list, for example `["CN","JP","US"]` |
| `access.customDomain` | empty | `domainName` + `certificateArn` (ACM certificate in **us-east-1**). Enforces TLS 1.2+ when set. You create the DNS CNAME to the CloudFront domain yourself |
| `access.originTls` | empty | `domainName` + `certificateArn` (ACM certificate in the **main region**). When set, CloudFront → ALB and MCP Lambda → ALB use HTTPS (TLS 1.2+). The stack creates a private hosted zone for `domainName` in the VPC; no public DNS record is needed |
| `security.waf` | `true` | AWS WAF web ACL on CloudFront (`<stackName>-Waf` stack). `access.allowedCidrs` needs it. Paid, see 7.8 |
| `security.cloudTrail` | `true` | Multi-Region CloudTrail trail into a KMS-encrypted bucket. Paid if the account already has a trail, see 7.8 |
| `security.guardDuty` | `true` | Amazon GuardDuty detector in the main region. Paid, see 7.8 |
| `security.vpcFlowLogs` | `true` | VPC Flow Logs (all traffic) for the new VPC, or for the VPC in `network.vpcId` |
| `cube.api` | 1 vCPU / 2 GB, 2–6 tasks | API task size and auto scaling range |
| `cube.refreshWorker` | 1 vCPU / 2 GB | Refresh Worker task size |
| `cube.cubestoreRouter` | 1 vCPU / 4 GB | Cube Store Router task size |
| `cube.cubestoreWorker` | 1 vCPU / 4 GB ×2, 50 GiB | Cube Store Worker size, count, and local cache disk |
| `cube.jwt` | empty | External IdP (JWKS) settings, see 3.1 |
| `cube.extraEnv` | `{}` | Extra Cube environment variables (**non-sensitive**), for example `CUBEJS_SCHEDULED_REFRESH_TIMEZONES` |
| `cube.enableExecuteCommand` | `false` | Allow `aws ecs execute-command` into containers; enable only for debugging |
| `dataSource.type` | `athena-demo` | `athena-demo` or `custom` |
| `dataSource.env` | `{}` | Non-sensitive data source variables |
| `dataSource.secretArn` / `secretEnv` | empty | Sensitive variables injected from Secrets Manager |
| `sqlApi.enabled` / `allowedCidrs` | `false` / `[]` | Internal SQL API |
| `mcp.enabled` | `true` | Remote MCP |
| `alarmEmail` | `""` | Alarm email (you must confirm the subscription from the email). Empty = alarms publish to the SNS topic with no subscriber |

The configuration is validated. For example, a `latest` version, `CUBEJS_DEV_MODE` or any credential-like variable (name ending in `PASS`, `PASSWORD`, `SECRET`, `TOKEN`, `PRIVATE_KEY`, `AWS_KEY`, `JWT_KEY`) in plain-text env, `access.allowedCidrs` with `security.waf: false`, a certificate outside us-east-1, `dataSource.type: custom` without `CUBEJS_DB_TYPE`, or `sqlApi.enabled` without `allowedCidrs` all fail with an error.

---

## 7. Security design (AWS best practices)

Designed according to the [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html). Synthesis always runs the [cdk-nag](https://github.com/cdklabs/cdk-nag) **AwsSolutions** rule pack; every suppression is justified in `infra/lib/nag-suppressions.ts`.

### 7.1 Network isolation

- All workload compute (ECS tasks and the MCP Lambda) runs in **private subnets** without public IPs; in a VPC created by the stack, the public subnets contain only NAT. CDK-managed deployment helper Lambdas (S3 asset copy, ECR image copy, bucket auto-delete) run outside the VPC.
- The ALB is **internal** and reached through a **CloudFront VPC Origin**, so there is no origin directly reachable from the internet. ALB security group ingress allows only the `com.amazonaws.global.cloudfront.origin-facing` managed prefix list and the MCP Lambda security group, on port 80, or 443 with `access.originTls`.
- **Minimal security groups**:
  - Cube API accepts traffic only from the ALB (4000) and the optional SQL NLB (15432).
  - Cube Store Router accepts only 3030 from Cube API / Refresh Worker; inter-node ports 9999 / 10001 are open only within the Cube Store security group.
  - MCP Lambda egress is limited to the ALB listener port.
  - Cube Store egress: HTTPS (443) plus its own inter-node ports. Cube API / Refresh Worker egress with the Athena demo: HTTPS (443) plus Cube Store 3030. With `dataSource.type: custom` their egress stays open, because the database host and port are yours to choose.
- The ALB routes only `/cubejs-api/*`, `/livez`, `/readyz`, and `/mcp`; every other path returns 404 (**Playground and dev-mode endpoints are unreachable**).
- **VPC endpoints** (`network.vpcEndpoints`, on by default): traffic to S3, ECR, CloudWatch Logs, and Secrets Manager (plus Athena and Glue with the Athena demo) stays inside the VPC.
- VPC Flow Logs (all traffic, KMS-encrypted, `security.vpcFlowLogs`) for the new VPC or the VPC in `network.vpcId`. For a VPC created by the stack, the default security group is locked down (`restrictDefaultSecurityGroup`).

### 7.2 Edge protection

- HTTPS only (`HTTPS_ONLY`), with HTTP/2 and HTTP/3; `TLSv1.2_2021` is enforced once a custom domain is configured.
- **AWS WAF** (`security.waf`, on by default):
  - Three managed rule groups: `AmazonIpReputationList`, `CommonRuleSet`, `KnownBadInputsRuleSet`.
  - Per-IP rate limiting. Optional IP allow list: when `access.allowedCidrs` is set, the web ACL default action becomes block and only listed IPs are allowed.
  - WAF logs go to CloudWatch with the **`authorization` header redacted**, encrypted with a CMK in us-east-1.
  - `SizeRestrictions_QUERYSTRING/BODY` in `CommonRuleSet` are set to Count so long Cube JSON queries are not blocked by mistake.
- Security response headers (HSTS, X-Content-Type-Options, X-Frame-Options, etc., via the CloudFront managed `SecurityHeadersPolicy`).
- Caching disabled (`CachingDisabled`) so authenticated responses are never cached and served to other users.

### 7.3 Identity and access

- Cube API enforces JWT authentication and runs with dev mode off (`CUBEJS_DEV_MODE=false`).
- The signing secret is randomly generated by Secrets Manager and **never appears in code, templates, or plain-text environment variables**; ECS injects it as a secret at start-up.
- **Least-privilege IAM with one role per component**:
  - Cube task role: read only the `conf/` prefix and (with the Athena demo) the demo data bucket; read and write (but not delete) in the Athena results bucket; use only the designated Athena workgroup and Glue database/tables; decrypt with the stack CMK.
  - Cube Store task role: read/write only the Cube Store bucket.
  - MCP Lambda: no data permissions at all; it only forwards the caller's token. `initialize` / `tools/list` requests, which never reach Cube data, are first checked against Cube, so an invalid token gets 401.
- No long-lived access keys. Cube Store and Athena get temporary credentials through ECS task roles.
- Tokens issued by `gen-token.mjs` expire after 24 hours by default, 90 days at most.

### 7.4 Data protection

- **One customer managed KMS key (CMK) with automatic rotation**, used for:
  - All application S3 buckets (SSE-KMS + Bucket Key)
  - CloudWatch log groups created by the stack (ECS containers, MCP Lambda, VPC Flow Logs). The WAF log group in us-east-1 uses its own CMK there. Not covered: the log groups that CDK helper Lambdas create automatically
  - Private ECR repositories
  - CloudTrail log files
  - Secrets Manager
  - SNS
  - Lambda environment variables
  - Athena query results
- S3:
  - All public access blocked on every bucket. Application buckets disable ACLs (BucketOwnerEnforced). The access-log bucket uses SSE-S3 and BucketOwnerPreferred, because S3/ALB access logging and CloudFront standard logging require them.
  - **TLS enforced** (`aws:SecureTransport`), minimum TLS 1.2.
  - Application buckets: versioning enabled (except the Athena results bucket) and server access logging enabled. The access-log bucket is versioned only in prod.
  - Lifecycle rules: the Cube Store bucket expires old versions after 7 days and aborts incomplete multipart uploads after 1 day; Athena results expire after 30 days; access logs expire after 90 days (dev) or 365 days (prod).
- The Athena workgroup enforces an encrypted result location and a per-query scan limit (10 GB).
- With `environment=prod`, S3 buckets, the KMS key, secrets, ECR repositories, and log groups are set to RETAIN, so deleting the stack leaves them in place.

### 7.5 Runtime and supply chain

- Image versions are pinned and mirrored into **private ECR** (KMS-encrypted): vulnerability scanning on push, immutable tags (IMMUTABLE), last 10 images kept. Running tasks pull only from private ECR; Docker Hub and ECR Public are contacted only at deploy time, when images are copied.
- The Cube API and Refresh Worker containers run as a **non-root user (UID 1000)** with a **read-only root filesystem**; only `/cube/conf` and `/tmp` have writable volumes. The short-lived `aws-cli` init container that syncs the data model runs with the image's default user.
- ECS Exec is off by default. If you turn it on, audit it with CloudTrail.
- Telemetry is disabled for Cube and Cube Store (`CUBEJS_TELEMETRY=false`, `CUBESTORE_TELEMETRY=false`).

### 7.6 Observability and auditing

- ECS Container Insights (Enhanced). All container logs go to CloudWatch Logs (KMS-encrypted). Container, MCP Lambda, VPC Flow Log, and WAF log groups keep logs for 30 days in dev and 1 year in prod.
- ALB and CloudFront access logs and S3 access logs (in the access-log bucket), VPC Flow Logs, WAF logs.
- **AWS CloudTrail** (`security.cloudTrail`): a multi-Region trail with management events, global service events, and log file validation, into a KMS-encrypted, versioned, access-logged S3 bucket (kept 90 days in dev, 365 in prod).
- **Amazon GuardDuty** (`security.guardDuty`): a detector in the main region. Findings with severity ≥ 7 go to the alarm SNS topic through an EventBridge rule. The rule is created even when `security.guardDuty` is false, so it also forwards findings from a detector you already run.
- Alarms (SNS, KMS-encrypted; notifications are delivered only if `alarmEmail` is set or you subscribe to `AlarmTopicArn`):
  - API 5xx (≥ 10 per 5 minutes)
  - Unhealthy targets (≥ 1)
  - p95 latency (≥ 10 s)
  - API CPU (≥ 85%)
  - Cube Store memory (≥ 90%, one alarm per router/worker)
  - MCP Lambda errors (≥ 5 per 5 minutes, only when MCP is enabled)
- X-Ray tracing enabled on the MCP Lambda.

### 7.7 Known trade-offs (and how to harden)

| Item | Current state | Hardening |
|---|---|---|
| TLS policy on the default CloudFront domain | Minimum version cannot be enforced (AWS limitation) | Configure `access.customDomain` |
| CloudFront → ALB, MCP Lambda → ALB | HTTP by default; traffic stays on the AWS network and the ALB is not internet-reachable | Set `access.originTls` (domain name + ACM certificate in the main region): HTTPS listener with TLS 1.2+, VPC Origin HTTPS_ONLY |
| Cube API / Refresh Worker egress with `dataSource.type: custom` | Open (database host and port are not known to the stack) | Edit `infra/lib/constructs/cube-services.ts` to allow only your database port and 443 |
| Traffic inside the VPC (ALB → Cube, Cube → Cube Store) | Plain text, confined to private subnets and restricted by security groups | If compliance requires it, use ECS Service Connect TLS or add TLS at the application layer |
| SQL API | NLB passes plain TCP (Postgres protocol TLS negotiation is incompatible with NLB TLS termination) | Allow only internal CIDRs; access via VPN / Direct Connect |
| API secret rotation | Not rotated automatically (rotation invalidates all tokens immediately) | Rotate manually on a schedule (see 8.5), or switch to JWKS (the IdP handles rotation) |
| Cube Store containers | Run as root (as in the official image) | Run only in private subnets; security groups restrict access to Cube components |

### 7.8 Security switches, account-level services, and cost

Paid security services are **on by default**. Turn each one off in `config.json` (`security.*`), with a `deploy.sh` flag, or with CDK context; a flag or context value overrides `config.json`:

| Switch | `deploy.sh` flag | CDK context |
|---|---|---|
| `security.waf` | `--no-waf` | `-c security.waf=false` |
| `security.cloudTrail` | `--no-cloudtrail` | `-c security.cloudTrail=false` |
| `security.guardDuty` | `--no-guardduty` | `-c security.guardDuty=false` |
| `security.vpcFlowLogs` | `--no-vpc-flow-logs` | `-c security.vpcFlowLogs=false` |

If you run `cdk` yourself, pass the same `-c` values to `cdk synth`, `cdk deploy` and `cdk destroy`.

**GuardDuty and CloudTrail are account-level services that may already be on.**

- **GuardDuty** allows one detector per account and Region. If one already exists (enabled by you, by AWS Organizations, or by another stack), creating a second fails the deployment with "a detector already exists". `deploy.sh` checks with `aws guardduty list-detectors` and, if the existing detector does not belong to this stack, skips creating one and prints a message. With `cdk deploy` directly, set `-c security.guardDuty=false`. If you later turn the switch off after the stack created the detector, the next deployment **deletes** that detector and its findings.
- **CloudTrail** never fails on a second trail (up to 5 trails per Region), but the first copy of management events is free and every additional copy is billed. `deploy.sh` warns when a multi-Region trail from outside this stack already exists. If your organization already has an organization trail, use `--no-cloudtrail`.
- **WAF** can be turned off when a central WAF (for example an AWS Firewall Manager policy) already protects the distribution. Every API call still needs a valid Cube JWT. Turning WAF off on an existing deployment leaves the `<stackName>-Waf` stack in us-east-1; delete it with `aws cloudformation delete-stack --region us-east-1 --stack-name <stackName>-Waf` after the main stack is updated.

**Added cost (us-east-1 list prices, check the pricing pages):**

| Service | Price | Typical dev account |
|---|---|---|
| AWS WAF | $5 per web ACL + $1 per rule (4 rules) per month, $0.60 per 1M requests | about $9 / month + requests |
| WAF log CMK (us-east-1) | $1 per key per month | $1 / month |
| CloudTrail | First copy of management events free; additional copies $2.00 per 100,000 events; S3 storage and KMS requests | $0–5 / month |
| GuardDuty | 30-day free trial, then per volume: CloudTrail management events $4.00 / 1M, VPC Flow Log and DNS analysis $1.00 / GB (first 500 GB), S3 data events $0.80 / 1M | a few dollars / month at low traffic |
| VPC Flow Logs | CloudWatch Logs vended-log ingestion from $0.50 / GB, plus storage | depends on traffic |
| Private hosted zone (`access.originTls` only) | $0.50 per zone per month | $0.50 / month |

See [AWS WAF](https://aws.amazon.com/waf/pricing/), [CloudTrail](https://aws.amazon.com/cloudtrail/pricing/), [GuardDuty](https://aws.amazon.com/guardduty/pricing/) and [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) pricing.

**Upgrading an existing deployment:** the private ECR repositories now use KMS encryption. CloudFormation cannot change the encryption of a repository, so the update creates new repositories and copies the images again. In `prod`, the old repositories are retained and can be deleted by hand.

### 7.9 Security checks

- `docs/security-review.md`: the security review this hardening is based on (findings, severity, location, fix).
- `scripts/security-check.sh`: runs without AWS credentials: `npm audit --audit-level=high`, type checks and unit tests for `mcp-server` and `infra`. The `infra` tests synthesize the stacks with a dummy account, so **cdk-nag runs on every switch combination**, and check that the security resources exist.
- `.github/workflows/security.yml` runs that script on every pull request, on pushes to `main`, and weekly. `.github/dependabot.yml` opens weekly update PRs for npm packages and GitHub Actions.

---

## 8. Operations

### 8.1 Upgrade Cube

1. Check the new version on [Docker Hub](https://hub.docker.com/r/cubejs/cube/tags) and [Cube Releases](https://github.com/cube-js/cube/releases) and read the changelog.
2. Change `cubeVersion` in `config.json`, for example to `"v1.8.14"`.
3. Run `./deploy.sh`: the new images are copied to ECR and ECS rolls the services in order. A failed deployment is rolled back automatically by the circuit breaker.

Cube Store router and workers are stopped before new tasks start (two nodes with the same name cannot coexist), so pre-aggregation queries may be briefly unavailable during an upgrade (about 1–2 minutes).

### 8.2 Scaling

- API: auto scales within `cube.api.minCount/maxCount` on 60% CPU, 75% memory, and 600 requests per target.
- Cube Store: adjust `cube.cubestoreWorker.count`, `cpu`, and `memoryMiB`. Changing the worker count restarts the router.
- Production recommendation: `environment: "prod"`, `maxAzs: 3`, API `minCount ≥ 3`, workers at 2 vCPU / 8 GB or more, then tune based on pre-aggregation data volume.

### 8.3 Logs and debugging

```bash
STACK=CubeCore; REGION=ap-northeast-1
# List this stack's log groups (names start with <stackName>-, e.g. CubeCore-CubeLogs...)
aws logs describe-log-groups --region $REGION --log-group-name-prefix "$STACK-" --query 'logGroups[].logGroupName' --output text
aws logs tail --follow --region $REGION <one of the log group names above>
```

Or go to the CloudWatch console → Logs and filter on `CubeCore-`. Log stream prefixes:

- `cube-api/*`
- `cube-refresh-worker/*`
- `cube-api-init/*`, `cube-refresh-worker-init/*` (init containers that sync the data model)
- `cubestore-router/*`
- `cubestore-worker-N/*`

### 8.4 Update only the data model

Change `cube/` and run `./deploy.sh`. CDK updates only the S3 content and the task definitions (`CUBE_CONF_SHA256` changes); the rolling update usually finishes in 3–5 minutes.

### 8.5 Rotate the API secret

```bash
aws secretsmanager put-secret-value --secret-id <ApiSecretArn> \
  --secret-string "$(openssl rand -hex 32)"
aws ecs list-services --cluster <ClusterName>   # find the Cube API and Refresh Worker service names
aws ecs update-service --cluster <ClusterName> --service <ApiService> --force-new-deployment
aws ecs update-service --cluster <ClusterName> --service <RefreshService> --force-new-deployment
```

Old tokens stop working immediately after rotation; issue new ones.

---

## 9. Cost estimate

Rough estimate for the default `dev` configuration in `ap-northeast-1` / `us-east-1` (on-demand prices, excluding data transfer and query volume):

| Resource | Size | Monthly cost (USD, approx.) |
|---|---|---|
| Fargate: Cube API ×2 | 1 vCPU / 2 GB | 70 |
| Fargate: Refresh Worker ×1 | 1 vCPU / 2 GB | 35 |
| Fargate: Cube Store Router + 2 Workers | 1 vCPU / 4 GB ×3, including extra storage | 130 |
| NAT Gateway ×1 | | 35 + traffic |
| VPC Interface Endpoints ×6 × 2 AZ | | 90 |
| ALB | | 20 + LCU |
| CloudFront + WAF | 3 managed rule groups + 1 rate-limit rule | 10 + requests |
| CloudTrail, GuardDuty, WAF log CMK | see 7.8 | 5–15 |
| KMS, Secrets Manager, CloudWatch, S3, Athena | | 10–20 |
| **Total** | | **About 405–465 / month** |

Ways to save:

- Turn off `network.vpcEndpoints` to save about $90 (AWS API traffic goes through NAT instead).
- Turn off security services you already run centrally (`--no-guardduty`, `--no-cloudtrail`, `--no-waf`, see 7.8).
- API `minCount: 1`.
- Reduce Cube Store workers to 1.
- Run `./destroy.sh` when you are done with a dev environment.

For an exact quote, use the [AWS Pricing Calculator](https://calculator.aws/).

---

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `The maximum number of VPCs has been reached` | The region has hit the VPC quota. Use another region, request a quota increase, or deploy into an existing VPC with `network.vpcId` |
| Stack is in `ROLLBACK_COMPLETE` and cannot be redeployed | Delete it first: `aws cloudformation delete-stack --stack-name <stack> --region <region>`, then run `./deploy.sh` |
| synth fails with `cdk-nag` errors | Your code change triggered a security rule. Fix it if possible; if a suppression is truly needed, justify it in `nag-suppressions.ts` |
| `ECRDeployment` fails / image pull fails | Anonymous Docker Hub pulls were rate limited; retry `./deploy.sh` later. Also check that the `cubeVersion` tag exists |
| ECS service never becomes healthy and the deployment rolls back | Check the `cube-api-init/*` logs (S3 sync failure) and `cube-api/*` logs (data model syntax errors, data source unreachable) |
| `403 Invalid token` | The token expired, or the signing secret was rotated; with JWKS, check `issuer` / `audience` |
| Keeps returning `Continue wait` | The query or pre-aggregation is still building. Clients should retry per the protocol; the MCP server retries automatically for 25 seconds (remote) or 120 seconds (local stdio) |
| Blocked by WAF (403, response from CloudFront) | Find the matching rule in CloudWatch Logs `aws-waf-logs-<stack>` (us-east-1) and adjust as needed |
| `{{ env_var(...) }}` in a model fails with `YAMLException: bad indentation` | Cube's Jinja JSON-escapes output by default (adding an extra pair of quotes). When concatenating strings, use `{{ env_var('X') \| safe }}` |
| `destroy.sh` fails with `The bucket you tried to delete is not empty` | Something was still writing to the bucket while it was being emptied (the stack stops Cube Store before emptying its bucket). Manually delete all object versions in that bucket, then rerun `./destroy.sh` |
| MCP returns 401 | The request is missing `Authorization: Bearer <token>` |

---

## 11. Cleanup

```bash
./destroy.sh
```

- `dev` environment: deletes the stack resources, including S3 data and ECR images. Log groups that CDK helper Lambdas create automatically (`/aws/lambda/<stackName>-...`) are not part of the stack and remain; delete them manually if needed.
- `prod` environment: S3 buckets, the KMS key, secrets, ECR repositories, and log groups are **retained**; delete them manually once you are sure they are no longer needed. KMS keys have a 7-day (dev) or 30-day (prod) pending deletion window.

---

## 12. Project structure

```
sample-cube-core-on-aws/
├── README.md / README.zh-CN.md  # Documentation (English / Chinese)
├── LICENSE / NOTICE             # MIT-0 license and copyright notice
├── THIRD-PARTY-LICENSES         # Licenses of third-party components (Cube Core: Apache-2.0)
├── CONTRIBUTING.md / CODE_OF_CONDUCT.md
├── deploy.sh / destroy.sh       # One-command deploy / delete
├── config.example.json          # Default configuration (copy to config.json and edit)
├── cube/                        # Cube configuration directory (cube.js + model/), synced to containers on deploy
├── sample-data/orders/          # Athena demo data (CSV)
├── scripts/
│   ├── gen-token.mjs            # Issues Cube JWTs with the secret from Secrets Manager
│   ├── smoke-test.sh            # Post-deployment smoke test
│   └── security-check.sh        # npm audit + tests + offline synth with cdk-nag (also run in CI)
├── docs/security-review.md      # Security review: findings and fixes
├── .github/                     # CI security workflow and Dependabot
├── mcp-server/                  # MCP server (TypeScript)
│   ├── src/server.ts            #   Tool definitions (list/describe/query/generate_sql)
│   ├── src/cube-client.ts       #   Cube REST client (handles Continue wait)
│   ├── src/lambda.ts            #   Remote: ALB → Lambda, Streamable HTTP
│   ├── src/stdio.ts             #   Local: stdio
│   └── test/                    #   Unit tests (node --test)
└── infra/                       # AWS CDK (TypeScript)
    ├── bin/app.ts               #   Entry point: reads config + CDK context switches
    ├── lib/build-app.ts         #   WAF stack (us-east-1, optional) + main stack + cdk-nag
    ├── lib/config.ts            #   Configuration loading and validation
    ├── lib/cube-stack.ts        #   Main stack: ECR, secrets, CloudFront, alarms, outputs
    ├── lib/waf-stack.ts         #   WAF web ACL
    ├── lib/nag-suppressions.ts  #   cdk-nag suppressions (with justifications)
    ├── test/                    #   Synth + cdk-nag tests (node --test)
    └── lib/constructs/
        ├── foundation.ts        #   KMS, VPC, Flow Logs, VPC endpoints, log bucket
        ├── images.ts            #   Public images → private ECR
        ├── cubestore.ts         #   Cube Store router + workers
        ├── cube-services.ts     #   Cube API, Refresh Worker, internal ALB, SQL API
        ├── athena-demo.ts       #   Demo dataset, Glue, Athena workgroup
        ├── mcp.ts               #   MCP Lambda
        └── security.ts          #   CloudTrail, GuardDuty, findings → SNS
```

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file. Cube Core (pulled as container images at deploy time) is licensed under [Apache-2.0](https://github.com/cube-js/cube/blob/master/LICENSE); see [THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES).

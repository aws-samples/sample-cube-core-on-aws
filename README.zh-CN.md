# Cube Core on AWS

在你自己的 AWS 账号里，用 **AWS CDK** 一条命令部署 [Cube Core](https://github.com/cube-js/cube)（开源语义层 / Semantic Layer），架构按 AWS 安全最佳实践设计。部署内容：

- **Cube API**：REST API，可选 Postgres 协议的 SQL API。
- **Refresh Worker**：后台构建预聚合。
- **Cube Store 集群**：预聚合存储、缓存和队列。
- **远程 MCP Server**：Claude、Cursor 等 AI Agent 可以直接通过语义层查数据。
- **Demo 数据源（可选）**：Athena 加一份示例数据集，部署完就能查。

[English](README.md)

> **重要提示：** 本项目是仅供演示和学习用途的示例代码，未经你自己的审查、测试和加固，不应直接用于生产环境。你需要对所部署 AWS 资源的安全、合规和费用负责。部署本示例会产生 AWS 费用（见[成本估算](#9-成本估算)）。

```bash
git clone https://github.com/aws-samples/sample-cube-core-on-aws.git && cd sample-cube-core-on-aws
./deploy.sh
```

> 当前锁定的 Cube 版本：`v1.8.13`（`config.json` → `cubeVersion`）。

---

## 目录

0. [什么时候选择 Cube Core](#0-什么时候选择-cube-core)
1. [架构](#1-架构)
2. [快速开始](#2-快速开始)
3. [使用 Cube：REST API / Token / SQL API](#3-使用-cube)
4. [MCP：接入 AI Agent](#4-mcp接入-ai-agent)
5. [接入你自己的数据源和数据模型](#5-接入你自己的数据源和数据模型)
6. [配置参考 config.json](#6-配置参考-configjson)
7. [安全设计（AWS 最佳实践）](#7-安全设计aws-最佳实践)
8. [运维：升级、扩缩容、日志、告警、密钥轮换](#8-运维)
9. [成本估算](#9-成本估算)
10. [故障排查](#10-故障排查)
11. [删除](#11-删除)
12. [项目结构](#12-项目结构)

---

## 0. 什么时候选择 Cube Core

### 0.1 Cube 解决什么问题

Cube 是一个 **语义层（Semantic Layer）**。它位于数据仓库/数据库和数据消费方之间。消费方包括 BI、内嵌分析、应用后端和 AI Agent。

指标口径（比如"GMV""活跃用户""复购率"）、表关联、维度和权限，都**只在 Cube 的数据模型（YAML/JS）里定义一次**。所有消费方都通过 Cube 的 API 拿结果，不再各自写 SQL。

| 常见痛点 | Cube 的解法 |
|---|---|
| 同一个指标在不同报表、不同团队里算出来不一样 | 指标集中定义、版本化（模型文件在 Git 里） |
| 前端或应用直接连数仓，慢、贵，还有并发问题 | **预聚合**：Cube Store 预先算好，亚秒级返回；还有查询缓存和队列，保护数仓 |
| 多租户 SaaS 需要按客户隔离数据 | JWT 的 `securityContext` 加 `queryRewrite`，在语义层强制行级权限 |
| 每种消费方都要单独对接 | 一份模型同时提供 REST、GraphQL、Postgres 协议的 SQL API，以及本方案的 MCP |
| 让大模型直接写 SQL，结果不准，也不安全 | Agent 只能在**已定义的 measures/dimensions** 里组合查询，口径一致，权限照样生效（见第 4 节） |

### 0.2 适合用 Cube Core 的场景

- **内嵌分析 / 客户可见的数据产品**：在 SaaS 应用里给客户展示报表和看板，要求低延迟、高并发、按租户隔离。这是 Cube 最典型的场景。
- **给 AI Agent / Chat BI 提供"受控的数据访问"**：用 MCP 或 REST，让 Agent 在语义层上查数，而不是直连数据库写 SQL。
- **多个 BI 工具和应用要共用同一套指标**：Tableau、Superset、Metabase、自研前端等。
- **数仓查询成本高或延迟高**：Athena 按扫描量计费，Redshift 或 Snowflake 并发有限。用预聚合把高频查询挡在数仓之前。
- **需要自托管**：数据不能出自己的 AWS 账号，有合规或数据驻留要求，或者希望用 Apache-2.0 开源组件、避免厂商锁定。

### 0.3 不太适合的场景

| 场景 | 更合适的选择 |
|---|---|
| 只有一个 BI 工具，报表不多，指标口径不复杂 | 直接用 Amazon QuickSight 连 Athena 或 Redshift，再加 SPICE |
| 主要是数据科学家做探索式、临时的复杂 SQL 分析 | 直接用 Athena、Redshift Query Editor 或 Notebook。语义层会限制灵活性 |
| 需要明细级 ETL 或数据转换 | Glue、dbt、EMR 等。Cube 不是 ETL 工具，它假设数据已经在仓库里建模好了 |
| 团队不想自己运维任何基础设施 | Cube Cloud（托管版），见下表 |
| 已经深度使用 dbt Cloud，指标都定义在 dbt 里 | 可以先评估 dbt Semantic Layer。Cube 也能读取 dbt 模型，两者并不互斥 |

### 0.4 Cube Core（本方案）和 Cube Cloud 对比

| | **Cube Core on AWS（本方案）** | **Cube Cloud** |
|---|---|---|
| 许可 / 费用 | Apache-2.0 开源，只付 AWS 资源费（dev 默认约 $400/月，见第 9 节） | 商业订阅，按套餐和用量计费 |
| 数据和部署位置 | 全部在你自己的 AWS 账号和 VPC 里 | Cube 托管（也有 BYOC 等私有部署选项） |
| 语义层、API、预聚合、Cube Store | ✅ 完整 | ✅ 完整 |
| 运维（升级、扩缩容、监控） | 自己负责，本方案用 CDK 和告警把它变简单 | Cube 托管 |
| 在线 IDE、模型开发环境、多环境 | ❌ 没有。在本地 `cube dev` 开发模型，用 Git 管理，部署时同步 | ✅ |
| AI、语义目录、BI 集成同步等增值功能 | ❌ 没有。本方案自带的 MCP Server 补上了"给 AI Agent 用"这一块 | ✅ |
| SSO / 用户管理 | 通过 JWT 或 JWKS 对接你自己的 IdP（比如 Cognito） | ✅ 内置 |

**一句话选型**：数据要留在自己账号、需要内嵌分析或给 Agent 用的受控数据访问、团队有能力运维 AWS 资源，就选 Cube Core on AWS。希望开箱即用、要在线 IDE 和企业级增值功能，就选 Cube Cloud。

---

## 1. 架构

```
                        ┌─────────────── us-east-1 ────────────────┐
                        │  AWS WAF (托管规则 + 限流 + 可选 IP 白名单) │
                        └───────────────────┬──────────────────────┘
 Client / BI / AI Agent                     │
        │  HTTPS                            ▼
        └──────────────────────────▶  Amazon CloudFront  ──(VPC Origin, AWS 内网)──┐
                                                                                  │
┌──────────────────────────────── VPC（你选择的 region）─────────────────────────────┼─────────┐
│  Private subnets（无公网 IP）                                                     ▼         │
│                                              ┌─────── Internal ALB（仅允许 CloudFront）──┐   │
│                                              │ /cubejs-api/*, /livez, /readyz → Cube API │   │
│                                              │ /mcp                           → MCP λ    │   │
│                                              │ 其他路径（Playground 等）       → 404      │   │
│                                              └──────────┬────────────────────┬───────────┘   │
│                                                         ▼                    ▼               │
│   ┌───────── ECS Fargate ─────────────────────────────────────┐    ┌─────────────────────┐  │
│   │ Cube API ×N (Auto Scaling)    Cube Refresh Worker ×1      │    │ MCP Server (Lambda) │  │
│   │   └ init 容器: S3 → /cube/conf (cube.js + model/)         │◀───│ 透传调用方的 JWT     │  │
│   │                    │ :3030                                │    └─────────────────────┘  │
│   │                    ▼                                      │                             │
│   │ Cube Store Router ──:9999/:10001── Cube Store Worker ×N   │  Cloud Map: *.cube.internal  │
│   └───────────────────────────┬───────────────────────────────┘                             │
│        VPC Endpoints: S3 / ECR / Logs / Secrets Manager / Athena / Glue                      │
└───────────────────────────────┼─────────────────────────────────────────────────────────────┘
                                ▼
   S3（KMS）: Cube Store 数据 · 数据模型 · Athena 结果 · Demo 数据        Secrets Manager（KMS）
   ECR（私有镜像镜像，扫描）· CloudWatch Logs（KMS）· Container Insights · SNS 告警
```

| 组件 | AWS 服务 | 说明 |
|---|---|---|
| 入口 | CloudFront + WAF | HTTPS 终结、全球边缘、托管防护规则、按 IP 限流 |
| 负载均衡 | **内网** ALB + CloudFront VPC Origin | ALB 不暴露公网。安全组只放行 CloudFront origin-facing 前缀列表 |
| Cube API | ECS Fargate 服务 | 按 CPU / 内存 / 请求数自动扩缩，滚动发布，失败自动回滚 |
| Refresh Worker | ECS Fargate 服务 | 构建、刷新预聚合（`CUBEJS_REFRESH_WORKER=true`） |
| Cube Store | ECS Fargate：1 Router + N Worker | 每个节点用固定的 Cloud Map DNS 名。持久数据写 S3（Task Role，无静态密钥） |
| 数据模型 | S3 + init 容器 | `./cube` 目录随部署上传。容器启动时同步，内容变化自动滚动更新。**不需要构建镜像，也不需要 Docker** |
| 镜像 | 私有 ECR | 部署时从 Docker Hub / ECR Public 复制到私有 ECR，push 时扫描，tag 不可变 |
| MCP | Lambda (Node.js 22, ARM64) | Streamable HTTP，无状态。挂在 ALB 的 `/mcp` 下 |
| Demo 数据 | S3 + Glue + Athena | 6000 行合成订单数据，独立 Workgroup，结果加密 |

---

## 2. 快速开始

### 2.1 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 运行 CDK 和脚本 |
| AWS CLI | v2 | 已配置凭证（`aws configure` / `AWS_PROFILE` / `aws sso login`） |
| IAM 权限 | 管理员或等效权限 | 首次需要 `cdk bootstrap`，会创建 IAM 角色、VPC、ECS 等资源 |
| Docker | **不需要** | 镜像由部署过程中的 Lambda 复制到 ECR，Lambda 由 esbuild 打包 |

账号配额请确认：目标 region 的 VPC 数量 < 5（默认上限），且 EIP 还有余量。

### 2.2 部署

```bash
./deploy.sh            # 交互确认后部署
./deploy.sh --yes      # CI / 非交互
AWS_PROFILE=prod ./deploy.sh
./deploy.sh --no-waf --no-guardduty   # 关闭收费的安全服务（见 7.8）
```

脚本依次执行：

1. 检查 Node、AWS CLI 和当前身份；首次运行会从 `config.example.json` 生成 `config.json`。
2. 安装依赖，跑 MCP Server 单元测试并构建。对两个包执行 `npm audit --omit=dev --audit-level=high`，发现 high/critical 漏洞就中止（`--skip-audit` 可跳过）。
3. 在目标 region，以及开启 WAF 时在 `us-east-1`（CloudFront 的 WAF 必须在这里）按需执行 `cdk bootstrap`。
4. `cdk synth`：同时跑 **cdk-nag AwsSolutions** 安全检查，有未豁免的问题就中止部署。
5. `cdk deploy --all`：先部署 `<stackName>-Waf`（us-east-1，开启 WAF 时），再部署主栈 `<stackName>`。首次约 15–20 分钟。
6. 冒烟测试：健康检查、未授权请求被拒、Playground 不可访问、元数据和查询正常、MCP 正常。

部署前想改 region、规模、数据源，就编辑 `config.json`（字段见 [第 6 节](#6-配置参考-configjson)）。最小示例：

```json
{
  "stackName": "CubeCore",
  "region": "ap-northeast-1",
  "environment": "dev"
}
```

没写的字段一律使用 `config.example.json` 中的默认值。

### 2.3 部署完成后

终端会打印：

```
 REST API : https://dxxxxxxxx.cloudfront.net/cubejs-api/v1
 MCP      : https://dxxxxxxxx.cloudfront.net/mcp
```

签发 Token 并查询：

```bash
TOKEN=$(node scripts/gen-token.mjs --quiet)
URL=https://dxxxxxxxx.cloudfront.net

curl -s -H "Authorization: $TOKEN" "$URL/cubejs-api/v1/meta" | jq '.cubes[].name'

curl -s -G -H "Authorization: $TOKEN" "$URL/cubejs-api/v1/load" \
  --data-urlencode 'query={"measures":["orders_view.total_amount"],"dimensions":["orders_view.product_category"],"order":{"orders_view.total_amount":"desc"}}' | jq '.data'
```

### 2.4 测试记录

本方案在 2026-10-27 实际部署到 `ap-northeast-1`（WAF 在 `us-east-1`）。`deploy.sh` 跑完后，冒烟测试（`scripts/smoke-test.sh`）和手动测试结果如下：

| 测试项 | 结果 |
|---|---|
| `cdk synth`，cdk-nag AwsSolutions 检查 | ✅ 没有未豁免的问题 |
| 全新部署（WAF 栈 + 主栈，157 个资源） | ✅ 约 18 分钟；只改数据模型后重新部署约 7 分钟 |
| `/readyz` 健康检查（经 CloudFront → VPC Origin → 内网 ALB） | ✅ 200 |
| 不带 token 访问 API | ✅ 403 |
| 访问 Playground（`/`）和未知路径 | ✅ 404，不暴露 |
| 用 HTTP 访问 | ✅ 被 CloudFront 拒绝（仅 HTTPS） |
| `/meta` 读取模型 | ✅ `orders`、`orders_view` |
| Athena 查询 `orders.count` | ✅ 6000 |
| 按月 × 品类查询，确认命中预聚合（说明 Cube Store 集群和 S3 存储都正常） | ✅ `usedPreAggregations: orders_daily_by_category_region` |
| MCP：`tools/list`、`cube_list_models`、`cube_query` | ✅ |
| MCP 不带 token | ✅ 401 |
| MCP Server 单元测试（`npm test`） | ✅ 4/4 |

**尚未实测**（配置已实现，但没有端到端跑过）：自定义数据源（Redshift/RDS/Snowflake）、JWKS/Cognito 认证、SQL API（NLB）、自定义域名、`environment: prod` 模式、部署到已有 VPC。建议在你的环境里先用 dev 模式验证这些功能。

---

## 3. 使用 Cube

### 3.1 认证模型

Cube 的每个 API 请求都要带 JWT（`Authorization: <token>`，也可以写成 `Bearer <token>`）。本方案支持两种方式：

| 模式 | 配置 | 适用场景 |
|---|---|---|
| **HS256 共享密钥**（默认） | 部署时自动生成 64 个字符的随机字母数字密钥，存进 Secrets Manager（KMS 加密） | 服务端签发 token，比如你的后端、BI 网关、MCP 客户端 |
| **外部 IdP / JWKS** | `cube.jwt.jwkUrl` / `issuer` / `audience` | 企业 SSO，比如 Amazon Cognito、Okta、Auth0、Entra ID |

签发 token（`scripts/gen-token.mjs`）：

```bash
node scripts/gen-token.mjs                                # 默认 24 小时
node scripts/gen-token.mjs --expires-in 7d                # 最长 90d
node scripts/gen-token.mjs --claims '{"region":"Europe"}' # 自定义 securityContext（行级权限）
node scripts/gen-token.mjs --stack CubeCore --region ap-northeast-1 --quiet
```

执行脚本的身份需要 `cloudformation:DescribeStacks`（用于查找 `ApiSecretArn` 输出；传了 `--secret-arn` 则不需要）、`secretsmanager:GetSecretValue`（该 secret）和 `kms:Decrypt`（栈的 CMK）权限。**不要把 API secret 下发到前端或客户端**，只在服务端签发短期 token。

设置了 `cube.jwt.jwkUrl` 后，Cube 会用你的 IdP 的 JWKS 校验 token，`gen-token.mjs` 签发的 HS256 token 预计不会被接受，`deploy.sh` 冒烟测试用的 token 也一样。

用 Amazon Cognito 的示例：

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

### 3.2 行级安全（多租户）

JWT 里的 claims 就是 Cube 的 `securityContext`。在 `cube/cube.js` 里用 `queryRewrite` 强制追加过滤条件，例子已经写好在注释里：

```js
queryRewrite: (query, { securityContext }) => {
  if (securityContext.region) {
    query.filters.push({ member: 'orders.region', operator: 'equals', values: [securityContext.region] });
  }
  return query;
},
```

用了 `queryRewrite` 的话，还需要配置 `scheduledRefreshContexts`，Refresh Worker 才能为每个租户构建预聚合。

### 3.3 REST API 常用端点

| 端点 | 说明 |
|---|---|
| `GET /cubejs-api/v1/meta` | 数据模型元数据 |
| `GET/POST /cubejs-api/v1/load` | 执行查询（可能返回 `{"error":"Continue wait"}`，需要重试） |
| `POST /cubejs-api/v1/sql` | 查看 Cube 生成的 SQL |
| `GET /readyz`、`/livez` | 健康检查（不需要认证） |

前端 SDK（`@cubejs-client/core`）的 `apiUrl` 设为 `https://<CubeUrl>/cubejs-api/v1`。

### 3.4 SQL API（可选，供 BI 工具使用）

Cube 的 SQL API 兼容 Postgres 协议，Tableau、Superset、Metabase、Power BI 等可以直接连。开启方法：

```json
"sqlApi": { "enabled": true, "allowedCidrs": ["10.0.0.0/8"] }
```

开启后会创建一个 **内网 NLB**（端口 15432），安全组只放行 `allowedCidrs`，用户名和密码自动生成并存进 Secrets Manager（输出 `SqlApiSecretArn`）。该端口只能从 VPC 内、对等 VPC、VPN 或 Direct Connect 访问，**不暴露公网**。

```bash
aws secretsmanager get-secret-value --secret-id <SqlApiSecretArn> --query SecretString --output text
psql "host=<SqlApiEndpoint 主机名> port=15432 user=cube dbname=db"
```

---

## 4. MCP：接入 AI Agent

本方案带一个 [MCP](https://modelcontextprotocol.io) Server（`mcp-server/`），AI Agent 可以通过 Cube 语义层安全地查数据，而不是直接写 SQL 连数据库。好处：指标口径统一，行级权限照样生效，还能命中预聚合。

### 4.1 提供的工具

| Tool | 作用 |
|---|---|
| `cube_list_models` | 列出 cubes / views 及其 measures、dimensions、segments |
| `cube_describe_model` | 查看某个 cube 或 view 的完整元数据（类型、描述、格式） |
| `cube_query` | 执行 Cube JSON 查询（自动处理 `Continue wait` 重试；默认 `limit` 100，最多返回 500 行） |
| `cube_generate_sql` | 校验查询，并返回 Cube 将要执行的 SQL（不实际执行） |

所有工具都标了 `readOnlyHint`，只读。

### 4.2 远程 MCP（部署在 AWS 上，推荐）

端点：`https://<CubeUrl>/mcp`（Streamable HTTP，无状态）。认证方式是 `Authorization: Bearer <Cube JWT>`。Lambda 本身**不持有任何密钥**，只把调用方的 token 透传给 Cube 校验，所以每个 Agent 和用户的权限都由各自的 token 决定。

**Claude Code**

```bash
TOKEN=$(node scripts/gen-token.mjs --expires-in 7d --quiet)
claude mcp add --transport http cube https://<CubeUrl>/mcp --header "Authorization: Bearer $TOKEN"
```

**Claude Desktop / Cursor / 其他支持 HTTP 的客户端**（`mcp.json` / `claude_desktop_config.json`）

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

只支持 stdio 的客户端，可以用 `mcp-remote` 桥接：`npx mcp-remote https://<CubeUrl>/mcp --header "Authorization: Bearer <CUBE_JWT>"`。

**Amazon Bedrock AgentCore / Strands Agents**：直接用 Streamable HTTP 客户端连 `https://<CubeUrl>/mcp`，带上同样的 header 即可。

### 4.3 本地 MCP（stdio）

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

### 4.4 用 curl 自测

```bash
curl -s -X POST https://<CubeUrl>/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"cube_query","arguments":{"measures":["orders_view.count"],"dimensions":["orders_view.region"]}}}' | jq -r '.result.content[0].text'
```

不想要 MCP 的话，设置 `"mcp": { "enabled": false }`。这样就不会创建 Lambda 函数、ALB 的 `/mcp` 规则、`McpUrl` 输出和 MCP 告警。

---

## 5. 接入你自己的数据源和数据模型

### 5.1 数据模型

`cube/` 目录就是 Cube 的配置目录，对应容器内的 `/cube/conf`：

```
cube/
├── cube.js              # Cube 配置（queryRewrite、contextToAppId 等）
└── model/
    ├── cubes/*.yml      # cubes
    └── views/*.yml      # views（推荐给 BI 和 AI 用）
```

修改后重新执行 `./deploy.sh` 即可：文件上传到 S3，CDK 根据目录内容的哈希触发 ECS 滚动更新，**不停服**。

> 如果 `cube.js` 需要 npm 依赖（`require('xxx')`），或者需要 Python 包，就得构建自定义镜像。做法见 [Cube 文档 · Extend the Docker image](https://cube.dev/docs/product/deployment/core#extend-the-docker-image)：推送到你的 ECR 后，修改 `infra/lib/cube-stack.ts` 中的 `cubeImage`。

### 5.2 数据源

把 `dataSource.type` 设为 `custom`。非敏感参数放 `env`；密码等敏感信息先存进 Secrets Manager，再通过 `secretEnv` 引用（ECS 在启动时注入，不会出现在任务定义明文里）。

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

**Amazon RDS / Aurora PostgreSQL**：`CUBEJS_DB_TYPE=postgres`，`CUBEJS_DB_SSL=true`。用 RDS 托管的主密码 secret 时，`secretEnv` 写 `{"CUBEJS_DB_USER":"username","CUBEJS_DB_PASS":"password"}`。

**Snowflake / BigQuery / Databricks / ClickHouse 等**：参见 [Cube 数据源文档](https://cube.dev/docs/product/configuration/data-sources)，变量照同样的方式放进 `env` / `secretEnv`。

**网络连通**

- 数据库在同一个 VPC：设置 `network.vpcId` 部署到现有 VPC（需要有带 NAT 出口的私有子网），然后在数据库安全组里放行 Cube 的安全组（`Cube/ApiSg`、`Cube/RefreshSg`）。
- 数据库在其他 VPC：用 VPC Peering 或 Transit Gateway。
- SaaS 数据仓库（Snowflake、BigQuery）：经 NAT 出公网。建议在对端把 NAT EIP 加进白名单。

**建议**：数据库账号只给只读权限。大数据量场景配置 `CUBEJS_DB_EXPORT_BUCKET`，并给 Task Role 追加对应 S3 权限，这样预聚合构建会快很多。

切换到自定义数据源后，记得删掉 `cube/model` 里的 demo 模型（`orders.yml` 依赖 Athena demo 才有的环境变量 `CUBE_DEMO_GLUE_DATABASE`）。

---

## 6. 配置参考 config.json

| 字段 | 默认值 | 说明 |
|---|---|---|
| `stackName` | `CubeCore` | CloudFormation 栈名（WAF 栈为 `<stackName>-Waf`） |
| `region` | `us-east-1` | 主栈 region |
| `environment` | `dev` | `prod` 会：保留 S3 桶、KMS 密钥、Secrets、ECR 仓库和日志组；开启 ALB/NLB 删除保护；每个 AZ 一个 NAT（仅新建 VPC）；日志保留 1 年 |
| `cubeVersion` | `v1.8.13` | `cubejs/cube` 和 `cubejs/cubestore` 的镜像 tag，**必须锁定版本**，禁止 `latest` |
| `network.vpcId` | `""` | 填了就部署进现有 VPC（需要有带出口的私有子网；此时栈不会创建 VPC Flow Logs 和 NAT 网关），否则新建 |
| `network.vpcCidr` | `10.80.0.0/16` | 新建 VPC 的 CIDR |
| `network.maxAzs` | `2` | 可用区数 |
| `network.natGateways` | `1` | 新建 VPC 的 NAT 网关数（prod 下自动 ≥ AZ 数） |
| `network.vpcEndpoints` | `true` | 创建 S3 网关终端节点，以及 ECR（API 和 Docker）、CloudWatch Logs、Secrets Manager 的接口终端节点；Athena、Glue 仅在 `athena-demo` 时创建。设置了 `vpcId` 且该 VPC 已有这些终端节点时，请设为 `false` |
| `access.allowedCidrs` | `[]` | WAF IP 白名单。为空时允许任意 IP（但仍需要有效 JWT） |
| `access.rateLimitPer5Min` | `2000` | 每个 IP 每 5 分钟的请求上限 |
| `access.geoAllowList` | `[]` | CloudFront 国家/地区白名单，比如 `["CN","JP","US"]` |
| `access.customDomain` | 空 | `domainName` + `certificateArn`（**us-east-1** 的 ACM 证书）。配置后强制 TLS 1.2+。DNS 需要你自己 CNAME 到 CloudFront 域名 |
| `access.originTls` | 空 | `domainName` + `certificateArn`（**主 region** 的 ACM 证书）。配置后 CloudFront → ALB、MCP Lambda → ALB 都走 HTTPS（TLS 1.2+）。栈会在 VPC 里为 `domainName` 建私有托管区，不需要公网 DNS 记录 |
| `security.waf` | `true` | CloudFront 上的 AWS WAF Web ACL（`<stackName>-Waf` 栈）。`access.allowedCidrs` 依赖它。收费，见 7.8 |
| `security.cloudTrail` | `true` | 多 Region CloudTrail trail，日志写入 KMS 加密的桶。账号里已有 trail 时会产生费用，见 7.8 |
| `security.guardDuty` | `true` | 在主 region 创建 Amazon GuardDuty detector。收费，见 7.8 |
| `security.vpcFlowLogs` | `true` | 为新建 VPC 或 `network.vpcId` 指定的 VPC 开启 VPC Flow Logs（全部流量） |
| `cube.api` | 1 vCPU / 2 GB，2–6 个 | API 规格和自动扩缩范围 |
| `cube.refreshWorker` | 1 vCPU / 2 GB | Refresh Worker 规格 |
| `cube.cubestoreRouter` | 1 vCPU / 4 GB | Cube Store Router 规格 |
| `cube.cubestoreWorker` | 1 vCPU / 4 GB ×2，50 GiB | Cube Store Worker 规格、数量、本地缓存盘 |
| `cube.jwt` | 空 | 外部 IdP（JWKS）配置，见 3.1 |
| `cube.extraEnv` | `{}` | 额外的 Cube 环境变量（**非敏感**），比如 `CUBEJS_SCHEDULED_REFRESH_TIMEZONES` |
| `cube.enableExecuteCommand` | `false` | 允许 `aws ecs execute-command` 进容器，仅调试时打开 |
| `dataSource.type` | `athena-demo` | `athena-demo` 或 `custom` |
| `dataSource.env` | `{}` | 数据源的非敏感变量 |
| `dataSource.secretArn` / `secretEnv` | 空 | 敏感变量从 Secrets Manager 注入 |
| `sqlApi.enabled` / `allowedCidrs` | `false` / `[]` | 内网 SQL API |
| `mcp.enabled` | `true` | 远程 MCP |
| `alarmEmail` | `""` | 告警邮箱（需要在邮件里点确认订阅）。为空时告警只发到没有订阅者的 SNS 主题 |

配置会做校验，比如：`latest` 版本、把 `CUBEJS_DEV_MODE` 或任何像凭证的变量（名字以 `PASS`、`PASSWORD`、`SECRET`、`TOKEN`、`PRIVATE_KEY`、`AWS_KEY`、`JWT_KEY` 结尾）写进明文 env、`security.waf: false` 却设置了 `access.allowedCidrs`、证书不在 us-east-1、`dataSource.type: custom` 却没有 `CUBEJS_DB_TYPE`、开启 `sqlApi.enabled` 却没有 `allowedCidrs` 等情况，都会直接报错。

---

## 7. 安全设计（AWS 最佳实践）

按 [AWS Well-Architected 安全支柱](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html) 设计。合成阶段强制跑 [cdk-nag](https://github.com/cdklabs/cdk-nag) **AwsSolutions** 规则包，所有豁免都在 `infra/lib/nag-suppressions.ts` 中写明了理由。

### 7.1 网络隔离

- 所有业务计算资源（ECS 任务和 MCP Lambda）都在**私有子网**，不分配公网 IP；栈新建的 VPC 中，公有子网里只有 NAT。CDK 管理的部署辅助 Lambda（S3 资产复制、ECR 镜像复制、桶自动清空）在 VPC 外运行。
- ALB 是 **internal** 类型，通过 **CloudFront VPC Origin** 接入，公网上没有可直连的源站。ALB 安全组入站只放行 `com.amazonaws.global.cloudfront.origin-facing` 托管前缀列表和 MCP Lambda 的安全组，端口为 80（配置 `access.originTls` 时为 443）。
- **最小化安全组**：
  - Cube API 只接受 ALB（4000）和可选 SQL NLB（15432）的流量。
  - Cube Store Router 只接受 Cube API / Refresh Worker 的 3030；节点间的 9999 / 10001 只在 Cube Store 安全组内部互通。
  - MCP Lambda 出站只能访问 ALB 的监听端口。
  - Cube Store 出站：HTTPS（443）加节点间端口。使用 Athena demo 时，Cube API / Refresh Worker 出站：HTTPS（443）加 Cube Store 3030。`dataSource.type: custom` 时这两者出站不限制，因为数据库地址和端口由你决定。
- ALB 只路由 `/cubejs-api/*`、`/livez`、`/readyz`、`/mcp`，其他路径一律 404（**Playground 和开发模式接口不可达**）。
- **VPC Endpoints**（`network.vpcEndpoints`，默认开启）：访问 S3、ECR、CloudWatch Logs、Secrets Manager（使用 Athena demo 时还有 Athena、Glue）的流量不出 VPC。
- VPC Flow Logs（全部流量，KMS 加密，`security.vpcFlowLogs`）：新建 VPC 和 `network.vpcId` 指定的 VPC 都会开启。栈新建的 VPC 还会收紧默认安全组（`restrictDefaultSecurityGroup`）。

### 7.2 边缘防护

- 只接受 HTTPS（`HTTPS_ONLY`），支持 HTTP/2 和 HTTP/3；配置自定义域名后强制 `TLSv1.2_2021`。
- **AWS WAF**（`security.waf`，默认开启）：
  - `AmazonIpReputationList`、`CommonRuleSet`、`KnownBadInputsRuleSet` 三组托管规则。
  - 按 IP 限流。可选 IP 白名单：设置 `access.allowedCidrs` 后，Web ACL 默认动作改为拦截，只放行名单内的 IP。
  - WAF 日志写入 CloudWatch，并**脱敏 `authorization` 头**，用 us-east-1 的 CMK 加密。
  - `CommonRuleSet` 中的 `SizeRestrictions_QUERYSTRING/BODY` 改为 Count 模式，避免误拦较长的 Cube JSON 查询。
- 安全响应头（HSTS、X-Content-Type-Options、X-Frame-Options 等，用 CloudFront 托管的 `SecurityHeadersPolicy`）。
- 关闭缓存（`CachingDisabled`），防止带鉴权的响应被缓存后串给其他用户。

### 7.3 身份与访问

- Cube API 强制 JWT 认证，并关闭开发模式（`CUBEJS_DEV_MODE=false`）。
- 签名密钥由 Secrets Manager 随机生成，**不出现在代码、模板和环境变量明文里**，ECS 启动时以 secret 方式注入。
- **IAM 最小权限，按组件拆分角色**：
  - Cube Task Role：只能读 `conf/` 前缀和（使用 Athena demo 时）demo 数据桶；读、写（不能删除）Athena 结果桶；只能使用指定的 Athena Workgroup 和 Glue 库表；可用栈的 CMK 解密。
  - Cube Store Task Role：只能读写 Cube Store 桶。
  - MCP Lambda：没有任何业务权限，只透传调用方 token。`initialize` / `tools/list` 这类不访问 Cube 数据的请求，会先拿 token 找 Cube 校验，无效 token 返回 401。
- 不使用任何长期 AK/SK。Cube Store 和 Athena 都通过 ECS Task Role 拿临时凭证。
- `gen-token.mjs` 签发的 token 默认 24 小时过期，最长 90 天。

### 7.4 数据保护

- **一个客户托管 KMS 密钥（CMK），开启自动轮换**，用于：
  - 所有业务 S3 桶（SSE-KMS + Bucket Key）
  - 栈创建的 CloudWatch 日志组（ECS 容器、MCP Lambda、VPC Flow Logs）。us-east-1 的 WAF 日志组用那里单独的 CMK。不包括 CDK 辅助 Lambda 自动创建的日志组
  - 私有 ECR 仓库
  - CloudTrail 日志文件
  - Secrets Manager
  - SNS
  - Lambda 环境变量
  - Athena 查询结果
- S3：
  - 所有桶都阻止公共访问。业务桶禁用 ACL（BucketOwnerEnforced）。访问日志桶使用 SSE-S3 和 BucketOwnerPreferred，因为 S3/ALB 访问日志和 CloudFront 标准日志需要这样配置。
  - **强制 TLS**（`aws:SecureTransport`），最低 TLS 1.2。
  - 业务桶开启版本控制（Athena 结果桶除外）和服务器访问日志。访问日志桶只在 prod 下开启版本控制。
  - 生命周期规则：Cube Store 桶 7 天后清理旧版本、1 天后清理未完成的分段上传；Athena 结果 30 天后过期；访问日志 90 天（dev）或 365 天（prod）后过期。
- Athena Workgroup 强制使用加密结果位置，并设置单次扫描上限（10 GB）。
- `environment=prod` 时，S3 桶、KMS 密钥、Secrets、ECR 仓库和日志组都设为 RETAIN，删栈后它们会保留。

### 7.5 运行时与供应链

- 镜像版本锁定，并镜像到**私有 ECR**（KMS 加密）：push 时扫描漏洞，tag 不可变（IMMUTABLE），保留最近 10 个镜像。运行中的任务只从私有 ECR 拉取镜像；只有部署时复制镜像才会访问 Docker Hub 和 ECR Public。
- Cube API 和 Refresh Worker 容器以**非 root 用户（UID 1000）**运行，**根文件系统只读**，只有 `/cube/conf` 和 `/tmp` 挂了可写卷。负责同步数据模型的短时 `aws-cli` init 容器使用镜像默认用户运行。
- 默认关闭 ECS Exec。打开时请配合 CloudTrail 审计。
- 关闭 Cube 和 Cube Store 的遥测（`CUBEJS_TELEMETRY=false`、`CUBESTORE_TELEMETRY=false`）。

### 7.6 可观测性和审计

- ECS Container Insights（Enhanced）。所有容器日志进 CloudWatch Logs（KMS 加密）。容器、MCP Lambda、VPC Flow Logs 和 WAF 的日志组在 dev 保留 30 天，prod 保留 1 年。
- ALB 和 CloudFront 访问日志、S3 访问日志（写入访问日志桶）、VPC Flow Logs、WAF 日志。
- **AWS CloudTrail**（`security.cloudTrail`）：多 Region trail，记录管理事件和全局服务事件，开启日志文件校验，写入 KMS 加密、开启版本控制和访问日志的 S3 桶（dev 保留 90 天，prod 保留 365 天）。
- **Amazon GuardDuty**（`security.guardDuty`）：在主 region 创建 detector。严重度 ≥ 7 的 finding 经 EventBridge 规则发到告警 SNS 主题。`security.guardDuty` 为 false 时也会创建这条规则，这样你已有的 detector 产生的 finding 也会转发过来。
- 告警（SNS，KMS 加密；只有设置了 `alarmEmail` 或你自己订阅了 `AlarmTopicArn`，才会收到通知）：
  - API 5xx（每 5 分钟 ≥ 10 次）
  - 不健康目标（≥ 1）
  - p95 延迟（≥ 10 秒）
  - API CPU（≥ 85%）
  - Cube Store 内存（≥ 90%，Router 和每个 Worker 各一个告警）
  - MCP Lambda 错误（每 5 分钟 ≥ 5 次，仅在开启 MCP 时）
- MCP Lambda 开启 X-Ray 追踪。

### 7.7 已知的取舍（以及如何加固）

| 项 | 现状 | 加固方式 |
|---|---|---|
| CloudFront 默认域名的 TLS 策略 | 无法强制最低版本（AWS 限制） | 配置 `access.customDomain` |
| CloudFront → ALB、MCP Lambda → ALB | 默认走 HTTP；流量在 AWS 内网，ALB 不可公网访问 | 配置 `access.originTls`（域名 + 主 region 的 ACM 证书）：HTTPS 监听器、TLS 1.2+，VPC Origin 改为 HTTPS_ONLY |
| `dataSource.type: custom` 时 Cube API / Refresh Worker 的出站 | 不限制（栈不知道数据库地址和端口） | 修改 `infra/lib/constructs/cube-services.ts`，只放行你的数据库端口和 443 |
| VPC 内部流量（ALB → Cube、Cube → Cube Store） | 明文，只在私有子网、经安全组限制 | 有合规要求时用 ECS Service Connect TLS，或在应用层加 TLS |
| SQL API | NLB 走 TCP 明文（Postgres 协议的 TLS 协商和 NLB TLS 终结不兼容） | 只放行内网 CIDR，通过 VPN / Direct Connect 访问 |
| API secret 轮换 | 不自动轮换（轮换后所有 token 立刻失效） | 定期手动轮换（见 8.5），或改用 JWKS（IdP 负责轮换） |
| Cube Store 容器 | 以 root 运行（官方镜像如此） | 只在私有子网运行，安全组限制为仅 Cube 内部访问 |

### 7.8 安全开关、账号级服务和费用

收费的安全服务**默认开启**。可以在 `config.json`（`security.*`）、`deploy.sh` 参数或 CDK context 里关闭；参数和 context 优先于 `config.json`：

| 开关 | `deploy.sh` 参数 | CDK context |
|---|---|---|
| `security.waf` | `--no-waf` | `-c security.waf=false` |
| `security.cloudTrail` | `--no-cloudtrail` | `-c security.cloudTrail=false` |
| `security.guardDuty` | `--no-guardduty` | `-c security.guardDuty=false` |
| `security.vpcFlowLogs` | `--no-vpc-flow-logs` | `-c security.vpcFlowLogs=false` |

自己执行 `cdk` 时，`cdk synth`、`cdk deploy`、`cdk destroy` 要带上同样的 `-c` 参数。

**GuardDuty 和 CloudTrail 是账号级服务，账号里可能已经开着。**

- **GuardDuty** 每个账号每个 Region 只能有一个 detector。已有 detector（你自己开的、AWS Organizations 统一开的、或别的栈建的）时再建一个，部署会失败，报 "a detector already exists"。`deploy.sh` 会用 `aws guardduty list-detectors` 检查：已有的 detector 不属于本栈时，就不再创建并打印提示。直接用 `cdk deploy` 时，请加 `-c security.guardDuty=false`。如果本栈已经建了 detector，之后又把开关关掉，下次部署会**删除**这个 detector 和它的 finding。
- **CloudTrail** 多建一个 trail 不会失败（每个 Region 最多 5 个），但管理事件只有第一份免费，多出来的每一份都收费。账号里已有不属于本栈的多 Region trail 时，`deploy.sh` 会提示。组织已有 organization trail 时，请用 `--no-cloudtrail`。
- **WAF**：已有统一的 WAF（例如 AWS Firewall Manager 策略）保护这个 distribution 时可以关闭。关闭后每个 API 请求仍需要有效的 Cube JWT。在已有部署上关闭 WAF 后，us-east-1 的 `<stackName>-Waf` 栈不会自动删除；主栈更新完后执行 `aws cloudformation delete-stack --region us-east-1 --stack-name <stackName>-Waf`。

**新增费用（us-east-1 标价，以官网定价页为准）：**

| 服务 | 价格 | 典型 dev 账号 |
|---|---|---|
| AWS WAF | 每个 Web ACL $5 + 每条规则 $1（共 4 条）/ 月，每百万请求 $0.60 | 约 $9 / 月 + 请求量 |
| WAF 日志 CMK（us-east-1） | 每个密钥 $1 / 月 | $1 / 月 |
| CloudTrail | 第一份管理事件免费；额外副本每 10 万事件 $2.00；另有 S3 存储和 KMS 请求费用 | $0–5 / 月 |
| GuardDuty | 30 天免费试用，之后按量：CloudTrail 管理事件 $4.00 / 百万，VPC Flow Log 和 DNS 分析 $1.00 / GB（前 500 GB），S3 数据事件 $0.80 / 百万 | 低流量时每月几美元 |
| VPC Flow Logs | CloudWatch Logs vended log 写入 $0.50 / GB 起，另加存储 | 取决于流量 |
| 私有托管区（仅 `access.originTls`） | 每个托管区 $0.50 / 月 | $0.50 / 月 |

定价见 [AWS WAF](https://aws.amazon.com/waf/pricing/)、[CloudTrail](https://aws.amazon.com/cloudtrail/pricing/)、[GuardDuty](https://aws.amazon.com/guardduty/pricing/)、[CloudWatch](https://aws.amazon.com/cloudwatch/pricing/)。

**升级已有部署**：私有 ECR 仓库改为 KMS 加密。CloudFormation 不能修改已有仓库的加密方式，所以更新时会新建仓库并重新复制镜像。`prod` 环境下旧仓库会被保留，可以手动删除。

### 7.9 安全检查

- `docs/security-review.md`：本次加固依据的安全评审报告（发现、严重程度、位置、修复方式）。
- `scripts/security-check.sh`：不需要 AWS 凭证，对 `mcp-server` 和 `infra` 执行 `npm audit --audit-level=high`、类型检查和单元测试。`infra` 的测试用虚拟账号 synth 整个应用，**每种开关组合都会跑 cdk-nag**，并检查安全资源是否存在。
- `.github/workflows/security.yml` 在每个 PR、推送到 `main` 时以及每周执行这个脚本。`.github/dependabot.yml` 每周为 npm 包和 GitHub Actions 发起更新 PR。

---

## 8. 运维

### 8.1 升级 Cube 版本

1. 在 [Docker Hub](https://hub.docker.com/r/cubejs/cube/tags) 和 [Cube Releases](https://github.com/cube-js/cube/releases) 确认新版本，阅读 changelog。
2. 修改 `config.json` 中的 `cubeVersion`，比如 `"v1.8.14"`。
3. 执行 `./deploy.sh`：新镜像会复制到 ECR，ECS 按顺序滚动更新。部署失败会被断路器自动回滚。

Cube Store 的 Router 和 Worker 采用先停后起（同名节点不能同时存在两个），升级期间预聚合查询可能短暂不可用（约 1–2 分钟）。

### 8.2 扩缩容

- API：在 `cube.api.minCount/maxCount` 范围内按 CPU 60%、内存 75%、每目标 600 请求自动扩缩。
- Cube Store：调整 `cube.cubestoreWorker.count`、`cpu`、`memoryMiB`。修改 Worker 数量会重启 Router。
- 生产建议：`environment: "prod"`、`maxAzs: 3`、API `minCount ≥ 3`、Worker 2 vCPU / 8 GB 以上，再根据预聚合的数据量调整。

### 8.3 日志和排障

```bash
STACK=CubeCore; REGION=ap-northeast-1
# 列出本栈的日志组（名称以 <stackName>- 开头，例如 CubeCore-CubeLogs...）
aws logs describe-log-groups --region $REGION --log-group-name-prefix "$STACK-" --query 'logGroups[].logGroupName' --output text
aws logs tail --follow --region $REGION <上面某个日志组名>
```

或者在 CloudWatch 控制台 → Logs → 筛选 `CubeCore-`。日志流前缀：

- `cube-api/*`
- `cube-refresh-worker/*`
- `cube-api-init/*`、`cube-refresh-worker-init/*`（同步数据模型的 init 容器）
- `cubestore-router/*`
- `cubestore-worker-N/*`

### 8.4 只更新数据模型

修改 `cube/` 后执行 `./deploy.sh`。CDK 只会更新 S3 内容和任务定义（`CUBE_CONF_SHA256` 变化），通常 3–5 分钟完成滚动更新。

### 8.5 轮换 API Secret

```bash
aws secretsmanager put-secret-value --secret-id <ApiSecretArn> \
  --secret-string "$(openssl rand -hex 32)"
aws ecs list-services --cluster <ClusterName>   # 查出 Cube API 和 Refresh Worker 的服务名
aws ecs update-service --cluster <ClusterName> --service <ApiService> --force-new-deployment
aws ecs update-service --cluster <ClusterName> --service <RefreshService> --force-new-deployment
```

轮换后旧 token 立刻失效，需要重新签发。

---

## 9. 成本估算

按 `ap-northeast-1` / `us-east-1` 的默认 `dev` 配置粗略估算（按需价格，不含数据传输和查询量）：

| 资源 | 规格 | 月成本（USD，约） |
|---|---|---|
| Fargate：Cube API ×2 | 1 vCPU / 2 GB | 70 |
| Fargate：Refresh Worker ×1 | 1 vCPU / 2 GB | 35 |
| Fargate：Cube Store Router + 2 Worker | 1 vCPU / 4 GB ×3，含额外存储 | 130 |
| NAT Gateway ×1 | | 35 + 流量 |
| VPC Interface Endpoints ×6 × 2 AZ | | 90 |
| ALB | | 20 + LCU |
| CloudFront + WAF | 3 组托管规则 + 1 条限流规则 | 10 + 请求量 |
| CloudTrail、GuardDuty、WAF 日志 CMK | 见 7.8 | 5–15 |
| KMS、Secrets Manager、CloudWatch、S3、Athena | | 10–20 |
| **合计** | | **约 405–465 / 月** |

省钱选项：

- 关闭 `network.vpcEndpoints`，省约 $90（AWS API 流量改走 NAT）。
- 关闭已在组织层面统一开启的安全服务（`--no-guardduty`、`--no-cloudtrail`、`--no-waf`，见 7.8）。
- API `minCount: 1`。
- Cube Store Worker 减到 1 个。
- 开发环境用完执行 `./destroy.sh`。

精确报价请用 [AWS Pricing Calculator](https://calculator.aws/)。

---

## 10. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `The maximum number of VPCs has been reached` | 该 region 的 VPC 数量到配额上限。换 region、申请提额，或者用 `network.vpcId` 部署到现有 VPC |
| 栈处于 `ROLLBACK_COMPLETE`，无法再次部署 | 先删除：`aws cloudformation delete-stack --stack-name <stack> --region <region>`，再执行 `./deploy.sh` |
| `cdk-nag` 报错导致 synth 失败 | 你改的代码触发了安全规则。优先修复；确实需要豁免的，在 `nag-suppressions.ts` 里写明理由 |
| `ECRDeployment` 失败 / 镜像拉取失败 | Docker Hub 匿名拉取被限流，稍后重试 `./deploy.sh`。也可以确认 `cubeVersion` 这个 tag 是否存在 |
| ECS 服务一直起不来，部署被回滚 | 查 `cube-api-init/*` 日志（S3 同步失败）和 `cube-api/*` 日志（数据模型语法错误、数据源连不上） |
| `403 Invalid token` | token 过期，或者签名密钥已经轮换；使用 JWKS 时检查 `issuer` / `audience` |
| 一直返回 `Continue wait` | 查询或预聚合还在构建。客户端按协议重试即可；MCP Server 会自动重试 25 秒（远程）或 120 秒（本地 stdio） |
| 被 WAF 拦截（403，响应来自 CloudFront） | 在 CloudWatch Logs `aws-waf-logs-<stack>`（us-east-1）里查命中的规则，按需调整 |
| 模型里 `{{ env_var(...) }}` 报 `YAMLException: bad indentation` | Cube 的 Jinja 默认对输出做 JSON 转义（会多一对引号）。拼接字符串时用 `{{ env_var('X') \| safe }}` |
| `destroy.sh` 报 `The bucket you tried to delete is not empty` | 清空桶的时候还有进程在往桶里写（栈会先停 Cube Store 再清空它的桶）。手动清空该桶的所有对象版本后重新执行 `./destroy.sh` |
| MCP 返回 401 | 请求头没带 `Authorization: Bearer <token>` |

---

## 11. 删除

```bash
./destroy.sh
```

- `dev` 环境：删除栈内资源，包括 S3 数据和 ECR 镜像。CDK 辅助 Lambda 自动创建的日志组（`/aws/lambda/<stackName>-...`）不属于栈，会留下来，需要的话手动删除。
- `prod` 环境：S3 桶、KMS 密钥、Secrets、ECR 仓库和日志组会被**保留**，确认不再需要后手动删除。KMS 密钥有 7 天（dev）或 30 天（prod）的删除等待期。

---

## 12. 项目结构

```
sample-cube-core-on-aws/
├── README.md / README.zh-CN.md  # 文档（英文 / 中文）
├── LICENSE / NOTICE             # MIT-0 许可与版权声明
├── THIRD-PARTY-LICENSES         # 第三方组件许可（Cube Core：Apache-2.0）
├── CONTRIBUTING.md / CODE_OF_CONDUCT.md
├── deploy.sh / destroy.sh       # 一键部署 / 删除
├── config.example.json          # 默认配置（复制为 config.json 修改）
├── cube/                        # Cube 配置目录（cube.js + model/），部署时同步到容器
├── sample-data/orders/          # Athena demo 数据（CSV）
├── scripts/
│   ├── gen-token.mjs            # 用 Secrets Manager 中的密钥签发 Cube JWT
│   ├── smoke-test.sh            # 部署后冒烟测试
│   └── security-check.sh        # npm audit + 测试 + 离线 synth 跑 cdk-nag（CI 也执行）
├── docs/security-review.md      # 安全评审报告：发现与修复
├── .github/                     # CI 安全检查工作流和 Dependabot
├── mcp-server/                  # MCP Server（TypeScript）
│   ├── src/server.ts            #   工具定义（list/describe/query/generate_sql）
│   ├── src/cube-client.ts       #   Cube REST 客户端（处理 Continue wait）
│   ├── src/lambda.ts            #   远程：ALB → Lambda，Streamable HTTP
│   ├── src/stdio.ts             #   本地：stdio
│   └── test/                    #   单元测试（node --test）
└── infra/                       # AWS CDK（TypeScript）
    ├── bin/app.ts               #   入口：读取配置和 CDK context 开关
    ├── lib/build-app.ts         #   WAF 栈（us-east-1，可选）+ 主栈 + cdk-nag
    ├── lib/config.ts            #   配置加载与校验
    ├── lib/cube-stack.ts        #   主栈：ECR、Secrets、CloudFront、告警、输出
    ├── lib/waf-stack.ts         #   WAF Web ACL
    ├── lib/nag-suppressions.ts  #   cdk-nag 豁免（附理由）
    ├── test/                    #   synth + cdk-nag 测试（node --test）
    └── lib/constructs/
        ├── foundation.ts        #   KMS、VPC、Flow Logs、VPC Endpoints、日志桶
        ├── images.ts            #   公共镜像 → 私有 ECR
        ├── cubestore.ts         #   Cube Store Router + Workers
        ├── cube-services.ts     #   Cube API、Refresh Worker、内网 ALB、SQL API
        ├── athena-demo.ts       #   Demo 数据集、Glue、Athena Workgroup
        ├── mcp.ts               #   MCP Lambda
        └── security.ts          #   CloudTrail、GuardDuty、finding → SNS
```

## 安全

安全问题报告方式见 [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications)。

## License

本示例采用 MIT-0 许可，见 [LICENSE](LICENSE)。Cube Core（部署时以容器镜像拉取）使用 [Apache-2.0](https://github.com/cube-js/cube/blob/master/LICENSE) 许可，见 [THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES)。

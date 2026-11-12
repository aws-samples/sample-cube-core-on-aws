# Security review / 安全评审

[English](#english) | [中文](#中文)

---

## English

Review date: 2026-11-12. Scope: everything in this repository at commit `74fe17d` (`infra/`, `mcp-server/`, `cube/`, `scripts/`, `deploy.sh`, `destroy.sh`, `config.example.json`). Line numbers refer to that commit. Fixes are in the same pull request as this report.

### How the review was done

| Check | Tool | Result at `74fe17d` |
|---|---|---|
| IaC and code review | Manual, against the AWS Well-Architected Security Pillar and the AWS Solutions rules | Findings below |
| cdk-nag | `cdk synth` with `AwsSolutionsChecks` (dummy account, no credentials) | 0 errors; every suppression has a reason |
| Exposure patterns | `grep` for `0.0.0.0/0` ingress, `AnyPrincipal`, public S3, open CORS, unauthenticated Lambda URLs, wildcard binds | None found |
| Hard-coded secrets / PII | `grep` for access keys, private keys, passwords, connection strings, SSN / email patterns (including `sample-data/`) | None found |
| Dependencies | `npm audit` on `infra/` and `mcp-server/` lock files | `mcp-server`: 0. `infra`: 3 moderate, see S-12 |

Not done: no deployment, no penetration test, no scan of the Cube / Cube Store container images (ECR scan-on-push covers them after deployment).

### Controls that were already in place

Private subnets for all workloads, internal ALB reached only through a CloudFront VPC origin, ALB ingress limited to the CloudFront origin-facing prefix list, HTTPS-only viewers, AWS WAF with managed rules and rate limiting, Cube JWT on every API call with dev mode off, Playground not routed, secrets in Secrets Manager (CMK), one CMK with rotation for S3 / logs / SNS / Lambda env / Athena results, S3 Block Public Access and TLS-only policies, non-root read-only Cube containers, pinned images mirrored into private ECR with scan on push, VPC Flow Logs on a new VPC, cdk-nag in every synth.

### Findings

Severity: **High** = missing control a reviewer would block on; **Medium** = weakens a control or leaves a gap an attacker or mistake could use; **Low** = defense in depth; **Info** = accepted, documented.

| ID | Severity | Location | Risk | Fix | Status |
|---|---|---|---|---|---|
| S-01 | High | `infra/lib/cube-stack.ts:185` (no trail anywhere) | No audit record of API calls against the stack (who read the secret, who changed a security group) unless the account already has a trail | Multi-Region CloudTrail trail, KMS-encrypted, log file validation, switch `security.cloudTrail` | Fixed |
| S-02 | High | `infra/lib/cube-stack.ts:185` (no detector) | No threat detection for credential misuse, crypto mining or data exfiltration | GuardDuty detector, switch `security.guardDuty`; severity ≥ 7 findings to the alarm topic | Fixed |
| S-03 | Medium | `mcp-server/src/lambda.ts:29-33` | The MCP gate only checks that a bearer token is present. `initialize` and `tools/list` never reach Cube, so any string is accepted for them | Verify the token against Cube before handling methods other than `tools/call`; 401 on failure | Fixed |
| S-04 | Medium | `infra/lib/cube-stack.ts:156-157`, `infra/lib/constructs/cube-services.ts:205-207`, `infra/lib/constructs/mcp.ts:49` | CloudFront → ALB and MCP Lambda → ALB are plain HTTP (inside the AWS network); requests carry the caller's JWT | Optional `access.originTls`: HTTPS:443 listener with TLS 1.2+ policy, VPC origin HTTPS_ONLY, private hosted zone so the MCP Lambda can verify the certificate | Fixed (opt-in, needs your domain and certificate) |
| S-05 | Medium | `infra/lib/constructs/cubestore.ts:49`, `infra/lib/constructs/cube-services.ts:64-65` | Cube Store, Cube API and Refresh Worker allow all outbound traffic, so a compromised container can reach any host and port | Cube Store: 443 + its own inter-node ports. Cube API / Refresh Worker with the Athena demo: 443 + Cube Store 3030 | Fixed for Athena demo; open egress kept for `custom` data sources (S-13) |
| S-06 | Medium | `infra/lib/constructs/foundation.ts:80-81` | With `network.vpcId` the stack creates no VPC Flow Logs, so network forensics depend on the existing VPC | Flow log on the existing VPC too, switch `security.vpcFlowLogs` | Fixed |
| S-07 | Medium | `infra/lib/config.ts:103-106` | Only 4 env names are blocked from plain-text config. `CUBEJS_AWS_SECRET`, `CUBEJS_DB_DATABRICKS_TOKEN` etc. would land in the task definition in plain text | Block any `dataSource.env` / `cube.extraEnv` name ending in `PASS`, `PASSWORD`, `SECRET`, `TOKEN`, `PRIVATE_KEY`, `AWS_KEY`, `JWT_KEY` | Fixed |
| S-08 | Medium | `deploy.sh:55-56` | Dependencies are installed with `--no-audit` and nothing else checks them; a vulnerable package would be deployed silently | `npm audit --omit=dev --audit-level=high` in `deploy.sh` (stops the deploy); `scripts/security-check.sh` + GitHub Actions workflow + Dependabot | Fixed |
| S-09 | Medium | `infra/bin/app.ts:13-27` | WAF is always created and there is no switch for paid services; operators who already run WAF / GuardDuty centrally get duplicates or a failed deployment | `security.*` switches in `config.json`, CDK context and `deploy.sh --no-*` flags; `deploy.sh` skips GuardDuty when a detector already exists | Fixed |
| S-10 | Low | `infra/lib/constructs/images.ts:31` | ECR repositories use AES-256 (AWS owned key) instead of the stack CMK | `RepositoryEncryption.KMS` with the stack CMK | Fixed (repositories are replaced on upgrade, see README 7.8) |
| S-11 | Low | `infra/lib/waf-stack.ts:78-82` | WAF logs (client IPs, URIs, headers) are not encrypted with a CMK | CMK with rotation in the WAF stack (us-east-1) | Fixed |
| S-12 | Low | `infra/package-lock.json` (`aws-cdk-lib` bundles `minimatch`) | GHSA-g3hv-75wg-m249 (moderate, ReDoS in glob matching). Runs only on the deploying machine during synth, never in AWS | None available without downgrading `aws-cdk-lib`; Dependabot will raise the fix | Open, accepted |
| S-13 | Low | `infra/lib/constructs/cube-services.ts:64-65` | With `dataSource.type: custom`, Cube API / Refresh Worker egress stays open, because the database host and port are user-defined | Documented in README 7.7 with the line to edit | Accepted |
| S-14 | Low | `infra/lib/constructs/athena-demo.ts:127` | `grantReadWrite` lets the Cube task delete Athena results it never needs to delete | `grantRead` + `grantPut` | Fixed |
| S-15 | Low | `infra/lib/constructs/cubestore.ts:85-92` | Cube Store runs as root with a writable root filesystem (upstream image) | Not changed: the upstream image expects it. Mitigated by private subnets and S-05 | Accepted |
| S-16 | Low | `infra/lib/constructs/cube-services.ts:203`, `infra/lib/constructs/cubestore.ts:52-53` | ALB → Cube API, Cube → Cube Store and the SQL API NLB are plain text inside private subnets | Not changed: Cube Store has no TLS option; README 7.7 lists Service Connect TLS | Accepted |
| S-17 | Low | `infra/lib/constructs/foundation.ts:117` | Interface endpoint security groups (CDK default) allow all egress | Not changed: endpoints do not open outbound connections | Accepted |
| S-18 | Info | `infra/lib/constructs/cube-services.ts:222` | `/livez` and `/readyz` answer without a token | Not changed: no data, used by `scripts/smoke-test.sh` | Accepted |
| S-19 | Info | `infra/lib/nag-suppressions.ts:13`, `:16` | HS256 API secret is not rotated automatically; TLS minimum cannot be enforced on `*.cloudfront.net` | Already documented (README 7.7, 8.5); use JWKS and `access.customDomain` | Accepted |

### What changed in the code

| Area | Files |
|---|---|
| CloudTrail, GuardDuty, findings → SNS | `infra/lib/constructs/security.ts` (new), `infra/lib/constructs/foundation.ts` (key policy for CloudTrail and EventBridge) |
| Switches | `config.example.json`, `infra/lib/config.ts`, `infra/bin/app.ts`, `infra/lib/build-app.ts` (new), `deploy.sh` |
| Origin TLS | `infra/lib/cube-stack.ts`, `infra/lib/constructs/cube-services.ts`, `infra/lib/constructs/mcp.ts` |
| Egress, IAM | `infra/lib/constructs/cubestore.ts`, `infra/lib/constructs/cube-services.ts`, `infra/lib/constructs/athena-demo.ts` |
| Encryption | `infra/lib/constructs/images.ts`, `infra/lib/waf-stack.ts` |
| MCP token check | `mcp-server/src/lambda.ts`, `mcp-server/src/cube-client.ts`, `mcp-server/test/lambda.test.ts`, `scripts/smoke-test.sh` |
| cdk-nag, scanning | `infra/lib/nag-suppressions.ts`, `infra/test/security.test.ts` (new), `scripts/security-check.sh` (new), `.github/workflows/security.yml` (new), `.github/dependabot.yml` (new) |

New cdk-nag suppressions, both conditional on a switch the operator turns off on purpose: `AwsSolutions-CFR2` (only when `security.waf=false`) and `AwsSolutions-VPC7` (only when `security.vpcFlowLogs=false`).

---

## 中文

评审日期：2026-11-12。范围：本仓库 `74fe17d` 提交的全部内容（`infra/`、`mcp-server/`、`cube/`、`scripts/`、`deploy.sh`、`destroy.sh`、`config.example.json`）。行号对应该提交。修复和本报告在同一个 PR 里。

### 评审方法

| 检查 | 工具 | `74fe17d` 的结果 |
|---|---|---|
| IaC 和代码评审 | 人工，对照 AWS Well-Architected 安全支柱和 AWS Solutions 规则 | 见下方发现 |
| cdk-nag | `cdk synth` + `AwsSolutionsChecks`（虚拟账号，无凭证） | 0 个 error；每个豁免都有理由 |
| 暴露面 | `grep` 检查 `0.0.0.0/0` 入站、`AnyPrincipal`、公开 S3、开放 CORS、无认证 Lambda URL、通配监听 | 未发现 |
| 硬编码密钥 / 个人信息 | `grep` 检查访问密钥、私钥、密码、连接串、SSN / 邮箱模式（含 `sample-data/`） | 未发现 |
| 依赖 | 对 `infra/`、`mcp-server/` 的 lock 文件执行 `npm audit` | `mcp-server`：0。`infra`：3 个 moderate，见 S-12 |

没有做：没有部署，没有渗透测试，没有扫描 Cube / Cube Store 容器镜像（部署后由 ECR push 扫描覆盖）。

### 原有的安全控制

所有工作负载在私有子网；ALB 为 internal，只能经 CloudFront VPC Origin 访问；ALB 入站只放行 CloudFront origin-facing 前缀列表；客户端只走 HTTPS；AWS WAF 托管规则加限流；所有 API 请求都要 Cube JWT，开发模式关闭；Playground 不路由；密钥在 Secrets Manager（CMK）；一个开启轮换的 CMK 加密 S3 / 日志 / SNS / Lambda 环境变量 / Athena 结果；S3 阻止公开访问并强制 TLS；Cube 容器非 root、根文件系统只读；镜像版本锁定并镜像到私有 ECR，push 时扫描；新建 VPC 开启 Flow Logs；每次 synth 都跑 cdk-nag。

### 发现

严重程度：**High** = 缺少评审会直接拦下的控制；**Medium** = 削弱某项控制，或留下可被攻击者或误操作利用的缺口；**Low** = 纵深防御；**Info** = 已接受并有文档说明。

| ID | 严重程度 | 位置 | 风险 | 修复 | 状态 |
|---|---|---|---|---|---|
| S-01 | High | `infra/lib/cube-stack.ts:185`（没有 trail） | 账号里没有现成 trail 时，对本栈资源的 API 调用（谁读了密钥、谁改了安全组）没有审计记录 | 多 Region CloudTrail trail，KMS 加密，开启日志文件校验，开关 `security.cloudTrail` | 已修复 |
| S-02 | High | `infra/lib/cube-stack.ts:185`（没有 detector） | 凭证滥用、挖矿、数据外传没有威胁检测 | GuardDuty detector，开关 `security.guardDuty`；严重度 ≥ 7 的 finding 发到告警主题 | 已修复 |
| S-03 | Medium | `mcp-server/src/lambda.ts:29-33` | MCP 入口只检查有没有 bearer token。`initialize`、`tools/list` 不会访问 Cube，任意字符串都能通过 | 处理 `tools/call` 以外的方法前，先拿 token 找 Cube 校验，失败返回 401 | 已修复 |
| S-04 | Medium | `infra/lib/cube-stack.ts:156-157`、`infra/lib/constructs/cube-services.ts:205-207`、`infra/lib/constructs/mcp.ts:49` | CloudFront → ALB、MCP Lambda → ALB 走明文 HTTP（在 AWS 内网），请求里带着调用方 JWT | 可选 `access.originTls`：HTTPS:443 监听器（TLS 1.2+），VPC Origin HTTPS_ONLY，私有托管区让 MCP Lambda 能校验证书 | 已修复（需要你提供域名和证书后开启） |
| S-05 | Medium | `infra/lib/constructs/cubestore.ts:49`、`infra/lib/constructs/cube-services.ts:64-65` | Cube Store、Cube API、Refresh Worker 出站全放开，容器被攻破后可以访问任意主机端口 | Cube Store：443 + 节点间端口。Athena demo 下的 Cube API / Refresh Worker：443 + Cube Store 3030 | Athena demo 已修复；`custom` 数据源保持出站开放（S-13） |
| S-06 | Medium | `infra/lib/constructs/foundation.ts:80-81` | 使用 `network.vpcId` 时栈不建 VPC Flow Logs，网络取证依赖现有 VPC | 现有 VPC 也加 Flow Log，开关 `security.vpcFlowLogs` | 已修复 |
| S-07 | Medium | `infra/lib/config.ts:103-106` | 只禁止了 4 个变量名写进明文配置。`CUBEJS_AWS_SECRET`、`CUBEJS_DB_DATABRICKS_TOKEN` 等会以明文进入 task definition | `dataSource.env` / `cube.extraEnv` 中名字以 `PASS`、`PASSWORD`、`SECRET`、`TOKEN`、`PRIVATE_KEY`、`AWS_KEY`、`JWT_KEY` 结尾的一律拒绝 | 已修复 |
| S-08 | Medium | `deploy.sh:55-56` | 用 `--no-audit` 安装依赖，没有其他检查；有漏洞的包会被悄悄部署 | `deploy.sh` 执行 `npm audit --omit=dev --audit-level=high`（失败即中止）；新增 `scripts/security-check.sh`、GitHub Actions 工作流和 Dependabot | 已修复 |
| S-09 | Medium | `infra/bin/app.ts:13-27` | WAF 总会创建，收费服务没有开关；已在组织层面统一开 WAF / GuardDuty 的用户会重复付费或部署失败 | `config.json`、CDK context 和 `deploy.sh --no-*` 三种开关；已有 detector 时 `deploy.sh` 自动不建 GuardDuty | 已修复 |
| S-10 | Low | `infra/lib/constructs/images.ts:31` | ECR 仓库用 AES-256（AWS 自有密钥），没有用栈的 CMK | 改为 `RepositoryEncryption.KMS` + 栈 CMK | 已修复（升级时会替换仓库，见 README 7.8） |
| S-11 | Low | `infra/lib/waf-stack.ts:78-82` | WAF 日志（客户端 IP、URI、请求头）没有用 CMK 加密 | WAF 栈（us-east-1）里新建开启轮换的 CMK | 已修复 |
| S-12 | Low | `infra/package-lock.json`（`aws-cdk-lib` 内置 `minimatch`） | GHSA-g3hv-75wg-m249（moderate，glob 匹配 ReDoS）。只在部署机器 synth 时运行，不会进入 AWS | 不降级 `aws-cdk-lib` 就没有修复版本；Dependabot 会在有修复时提 PR | 未修复，已接受 |
| S-13 | Low | `infra/lib/constructs/cube-services.ts:64-65` | `dataSource.type: custom` 时 Cube API / Refresh Worker 出站仍开放，因为数据库地址和端口由用户决定 | README 7.7 写明要改哪一行 | 已接受 |
| S-14 | Low | `infra/lib/constructs/athena-demo.ts:127` | `grantReadWrite` 让 Cube 任务能删除 Athena 结果，但它不需要删除 | 改为 `grantRead` + `grantPut` | 已修复 |
| S-15 | Low | `infra/lib/constructs/cubestore.ts:85-92` | Cube Store 以 root 运行，根文件系统可写（上游镜像如此） | 未改：上游镜像依赖这一点。由私有子网和 S-05 缓解 | 已接受 |
| S-16 | Low | `infra/lib/constructs/cube-services.ts:203`、`infra/lib/constructs/cubestore.ts:52-53` | ALB → Cube API、Cube → Cube Store、SQL API NLB 在私有子网内是明文 | 未改：Cube Store 没有 TLS 选项；README 7.7 给出了 Service Connect TLS 方案 | 已接受 |
| S-17 | Low | `infra/lib/constructs/foundation.ts:117` | Interface endpoint 的安全组（CDK 默认）出站全放开 | 未改：endpoint 不会主动发起出站连接 | 已接受 |
| S-18 | Info | `infra/lib/constructs/cube-services.ts:222` | `/livez`、`/readyz` 不需要 token | 未改：不含数据，`scripts/smoke-test.sh` 依赖它们 | 已接受 |
| S-19 | Info | `infra/lib/nag-suppressions.ts:13`、`:16` | HS256 API secret 不自动轮换；`*.cloudfront.net` 无法强制最低 TLS 版本 | 已有文档（README 7.7、8.5）；可改用 JWKS 和 `access.customDomain` | 已接受 |

### 代码改动

| 方面 | 文件 |
|---|---|
| CloudTrail、GuardDuty、finding → SNS | `infra/lib/constructs/security.ts`（新增）、`infra/lib/constructs/foundation.ts`（CloudTrail 和 EventBridge 的密钥策略） |
| 开关 | `config.example.json`、`infra/lib/config.ts`、`infra/bin/app.ts`、`infra/lib/build-app.ts`（新增）、`deploy.sh` |
| 源站 TLS | `infra/lib/cube-stack.ts`、`infra/lib/constructs/cube-services.ts`、`infra/lib/constructs/mcp.ts` |
| 出站、IAM | `infra/lib/constructs/cubestore.ts`、`infra/lib/constructs/cube-services.ts`、`infra/lib/constructs/athena-demo.ts` |
| 加密 | `infra/lib/constructs/images.ts`、`infra/lib/waf-stack.ts` |
| MCP token 校验 | `mcp-server/src/lambda.ts`、`mcp-server/src/cube-client.ts`、`mcp-server/test/lambda.test.ts`、`scripts/smoke-test.sh` |
| cdk-nag、扫描 | `infra/lib/nag-suppressions.ts`、`infra/test/security.test.ts`（新增）、`scripts/security-check.sh`（新增）、`.github/workflows/security.yml`（新增）、`.github/dependabot.yml`（新增） |

新增的 cdk-nag 豁免都只在运维人员主动关闭对应开关时生效：`AwsSolutions-CFR2`（仅 `security.waf=false`）和 `AwsSolutions-VPC7`（仅 `security.vpcFlowLogs=false`）。

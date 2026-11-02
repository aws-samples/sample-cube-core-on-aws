import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TaskSize {
  cpu: number;
  memoryMiB: number;
}

export interface CubeOnAwsConfig {
  stackName: string;
  region: string;
  /** "prod" retains data, enables deletion protection and uses one NAT gateway per AZ. */
  environment: 'dev' | 'prod';
  /** Tag of cubejs/cube and cubejs/cubestore images (pin it; do not use "latest"). */
  cubeVersion: string;
  network: {
    /** Deploy into an existing VPC (must have private subnets with egress). Empty = create a new VPC. */
    vpcId: string;
    vpcCidr: string;
    maxAzs: number;
    natGateways: number;
    /** Interface/gateway VPC endpoints so that AWS API traffic never leaves the VPC. */
    vpcEndpoints: boolean;
  };
  access: {
    /** WAF IP allow list (CIDRs). Empty = allow any IP (still requires a valid Cube JWT). */
    allowedCidrs: string[];
    /** WAF rate limit per source IP per 5 minutes. */
    rateLimitPer5Min: number;
    /** ISO 3166-1 alpha-2 country codes allowed by CloudFront. Empty = no geo restriction. */
    geoAllowList: string[];
    /** Optional custom domain; certificate must be in us-east-1 (CloudFront requirement). */
    customDomain: { domainName: string; certificateArn: string };
  };
  cube: {
    api: TaskSize & { minCount: number; maxCount: number };
    refreshWorker: TaskSize;
    cubestoreRouter: TaskSize;
    cubestoreWorker: TaskSize & { count: number; ephemeralStorageGiB: number };
    /** Use an external IdP (e.g. Amazon Cognito) instead of the generated HS256 API secret. */
    jwt: { jwkUrl: string; issuer: string; audience: string; algorithms: string; claimsNamespace: string };
    /** Extra non-secret environment variables for Cube API and refresh worker. */
    extraEnv: Record<string, string>;
    /** Allow `aws ecs execute-command` into Cube containers (debugging only). */
    enableExecuteCommand: boolean;
  };
  dataSource: {
    /** "athena-demo": Athena + sample dataset created by the stack. "custom": your own database. */
    type: 'athena-demo' | 'custom';
    /** Non-secret Cube data source variables, e.g. CUBEJS_DB_TYPE, CUBEJS_DB_HOST, CUBEJS_DB_NAME. */
    env: Record<string, string>;
    /** Secrets Manager secret holding DB credentials (JSON). */
    secretArn: string;
    /** Map of Cube env var -> JSON key in the secret, e.g. {"CUBEJS_DB_PASS": "password"}. */
    secretEnv: Record<string, string>;
  };
  sqlApi: {
    /** Expose Cube's Postgres-compatible SQL API on an internal NLB (port 15432). */
    enabled: boolean;
    /** CIDRs (inside your network, e.g. VPN/peered VPC) allowed to reach the SQL API. */
    allowedCidrs: string[];
  };
  mcp: { enabled: boolean };
  /** Email subscribed to the alarm SNS topic. Empty = no subscription. */
  alarmEmail: string;
}

const ROOT = path.resolve(__dirname, '..', '..');

function deepMerge<T>(base: T, override: any): T {
  if (override === undefined || override === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return override as T;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k.startsWith('$')) continue;
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function loadConfig(file = process.env.CUBE_CONFIG ?? path.join(ROOT, 'config.json')): CubeOnAwsConfig {
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const cfg = deepMerge<CubeOnAwsConfig>(defaults, user);
  delete (cfg as any).$comment;
  validate(cfg);
  return cfg;
}

export function validate(cfg: CubeOnAwsConfig): void {
  const errors: string[] = [];
  if (!/^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(cfg.stackName)) errors.push('stackName must be alphanumeric/hyphen, <= 41 chars');
  if (!['dev', 'prod'].includes(cfg.environment)) errors.push('environment must be "dev" or "prod"');
  if (!cfg.cubeVersion || cfg.cubeVersion === 'latest') errors.push('cubeVersion must be a pinned tag such as v1.8.13');
  if (cfg.cube.cubestoreWorker.count < 1) errors.push('cube.cubestoreWorker.count must be >= 1');
  if (cfg.cube.api.minCount < 1 || cfg.cube.api.maxCount < cfg.cube.api.minCount) errors.push('cube.api min/max count invalid');
  if (cfg.dataSource.type === 'custom' && !cfg.dataSource.env.CUBEJS_DB_TYPE) {
    errors.push('dataSource.env.CUBEJS_DB_TYPE is required when dataSource.type is "custom"');
  }
  if (Object.keys(cfg.dataSource.secretEnv).length > 0 && !cfg.dataSource.secretArn) {
    errors.push('dataSource.secretArn is required when dataSource.secretEnv is set');
  }
  const forbidden = ['CUBEJS_API_SECRET', 'CUBEJS_DB_PASS', 'CUBEJS_SQL_PASSWORD', 'CUBEJS_DEV_MODE'];
  for (const k of [...Object.keys(cfg.cube.extraEnv), ...Object.keys(cfg.dataSource.env)]) {
    if (forbidden.includes(k)) errors.push(`${k} must not be set as plain env; secrets go through dataSource.secretEnv`);
  }
  const d = cfg.access.customDomain;
  if (!!d.domainName !== !!d.certificateArn) errors.push('access.customDomain needs both domainName and certificateArn');
  if (d.certificateArn && !d.certificateArn.startsWith('arn:aws:acm:us-east-1:')) errors.push('customDomain.certificateArn must be an ACM certificate in us-east-1');
  for (const c of [...cfg.access.allowedCidrs, ...cfg.sqlApi.allowedCidrs]) {
    if (!/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(c)) errors.push(`invalid CIDR: ${c}`);
  }
  if (cfg.sqlApi.enabled && cfg.sqlApi.allowedCidrs.length === 0) errors.push('sqlApi.allowedCidrs is required when sqlApi.enabled');
  if (errors.length) throw new Error('Invalid config.json:\n  - ' + errors.join('\n  - '));
}

export const PATHS = {
  root: ROOT,
  cubeConf: path.join(ROOT, 'cube'),
  sampleData: path.join(ROOT, 'sample-data'),
  mcpServer: path.join(ROOT, 'mcp-server'),
};

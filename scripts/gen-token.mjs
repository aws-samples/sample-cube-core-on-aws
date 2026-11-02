#!/usr/bin/env node
// Issues a Cube JWT (HS256) signed with the CUBEJS_API_SECRET stored in AWS Secrets Manager.
//
//   node scripts/gen-token.mjs [--stack CubeCore] [--region us-east-1] [--expires-in 24h]
//                              [--claims '{"region":"Europe"}'] [--secret-arn arn:...] [--quiet]
//
// The claims become Cube's securityContext (use them in queryRewrite for row-level security).
// Requires secretsmanager:GetSecretValue on the secret (+ kms:Decrypt on the stack key).
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
const cfg = { ...readJson(join(root, 'config.example.json')), ...readJson(join(root, 'config.json')) };
const stack = args.stack ?? cfg.stackName;
const region = args.region ?? cfg.region;

const aws = (...a) => execFileSync('aws', [...a, '--region', region, '--output', 'text'], { encoding: 'utf8' }).trim();

let secretArn = args['secret-arn'];
if (!secretArn) {
  secretArn = aws('cloudformation', 'describe-stacks', '--stack-name', stack, '--query', "Stacks[0].Outputs[?OutputKey=='ApiSecretArn'].OutputValue");
  if (!secretArn || secretArn === 'None') throw new Error(`Output ApiSecretArn not found on stack ${stack} in ${region}`);
}
const secret = aws('secretsmanager', 'get-secret-value', '--secret-id', secretArn, '--query', 'SecretString');

const parseDuration = (s) => {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`Invalid --expires-in "${s}" (use e.g. 30m, 24h, 7d)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
};
const ttl = parseDuration(args['expires-in'] ?? '24h');
if (ttl > 90 * 86400) throw new Error('--expires-in must be <= 90d; issue short-lived tokens and rotate');

const now = Math.floor(Date.now() / 1000);
const claims = args.claims && args.claims !== 'true' ? JSON.parse(args.claims) : {};
const payload = { iat: now, exp: now + ttl, ...claims };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
const token = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;

if (args.quiet) {
  process.stdout.write(token);
} else {
  console.error(`Cube JWT for stack ${stack} (expires ${new Date((now + ttl) * 1000).toISOString()}):`);
  console.log(token);
}

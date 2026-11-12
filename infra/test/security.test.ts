import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildApp } from '../lib/build-app';
import { CubeOnAwsConfig, loadConfig, securityOverrides, validate } from '../lib/config';

// Synthesizes offline: lookups get CDK dummy values, asset bundling is skipped, and cdk-nag
// (AwsSolutions) runs exactly as in `cdk synth`: any unsuppressed error makes app.synth() throw.
const cdkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));
const defaults = (overrides: Partial<CubeOnAwsConfig['security']> = {}) => loadConfig(path.join(os.tmpdir(), 'no-such-config.json'), overrides);

function synth(config: CubeOnAwsConfig) {
  const app = new App({
    context: { ...cdkJson.context, 'aws:cdk:bundling-stacks': [] },
    outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'cube-synth-')),
  });
  const stacks = buildApp(app, config, '123456789012');
  app.synth();
  return { main: Template.fromStack(stacks.main), waf: stacks.waf && Template.fromStack(stacks.waf) };
}

test('defaults: WAF, CloudTrail, GuardDuty, flow logs and KMS-encrypted ECR are on and cdk-nag passes', () => {
  const { main, waf } = synth(defaults());
  assert.ok(waf, 'WAF stack is created');
  waf.resourceCountIs('AWS::WAFv2::WebACL', 1);
  waf.hasResourceProperties('AWS::Logs::LogGroup', { KmsKeyId: {} });
  main.resourceCountIs('AWS::GuardDuty::Detector', 1);
  main.resourceCountIs('AWS::EC2::FlowLog', 1);
  main.hasResourceProperties('AWS::CloudTrail::Trail', { IsMultiRegionTrail: true, EnableLogFileValidation: true, KMSKeyId: {} });
  for (const repo of Object.values(main.findResources('AWS::ECR::Repository'))) {
    assert.equal(repo.Properties.EncryptionConfiguration.EncryptionType, 'KMS');
  }
});

test('paid services can be switched off and cdk-nag still passes', () => {
  const { main, waf } = synth(defaults({ waf: false, cloudTrail: false, guardDuty: false, vpcFlowLogs: false }));
  assert.equal(waf, undefined);
  main.resourceCountIs('AWS::GuardDuty::Detector', 0);
  main.resourceCountIs('AWS::CloudTrail::Trail', 0);
  main.resourceCountIs('AWS::EC2::FlowLog', 0);
});

test('Cube Store and (Athena demo) Cube tasks only open HTTPS egress to the internet', () => {
  const { main } = synth(defaults());
  const sgs = main.findResources('AWS::EC2::SecurityGroup');
  for (const [id, sg] of Object.entries(sgs)) {
    if (!/^(CubeStoreSg|CubeApiSg|CubeRefreshSg)/.test(id)) continue;
    for (const rule of sg.Properties.SecurityGroupEgress ?? []) {
      if (rule.CidrIp === '0.0.0.0/0') assert.deepEqual([rule.IpProtocol, rule.FromPort, rule.ToPort], ['tcp', 443, 443], id);
    }
  }
});

test('context switches parse true/false and reject anything else', () => {
  const ctx: Record<string, unknown> = { 'security.waf': 'false', 'security.guardDuty': true };
  assert.deepEqual(securityOverrides((k) => ctx[k]), { waf: false, guardDuty: true });
  assert.throws(() => securityOverrides((k) => (k === 'security.cloudTrail' ? 'no' : undefined)), /true or false/);
});

test('config validation blocks plain-text credentials and an IP allow list without WAF', () => {
  const cfg = defaults();
  cfg.dataSource.env = { CUBEJS_DB_DATABRICKS_TOKEN: 'x', CUBEJS_AWS_SECRET: 'y' };
  assert.throws(() => validate(cfg), /CUBEJS_DB_DATABRICKS_TOKEN.*\n.*CUBEJS_AWS_SECRET/);
  const noWaf = defaults({ waf: false });
  noWaf.access.allowedCidrs = ['203.0.113.0/24'];
  assert.throws(() => validate(noWaf), /needs security.waf/);
});

#!/usr/bin/env node
import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config';
import { CubeStack } from '../lib/cube-stack';
import { applyNagSuppressions } from '../lib/nag-suppressions';
import { CubeWafStack } from '../lib/waf-stack';

const config = loadConfig();
const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;

const waf = new CubeWafStack(app, `${config.stackName}-Waf`, {
  config,
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  description: 'Cube on AWS - WAF web ACL for CloudFront',
});

const main = new CubeStack(app, config.stackName, {
  config,
  webAclArn: waf.webAclArn,
  env: { account, region: config.region },
  crossRegionReferences: true,
  description: 'Cube on AWS - Cube Core semantic layer on ECS Fargate (API, refresh worker, Cube Store, MCP)',
});
main.addStackDependency(waf);

for (const s of [waf, main]) {
  Tags.of(s).add('Project', 'cube-on-aws');
  Tags.of(s).add('Environment', config.environment);
  Tags.of(s).add('CubeStack', config.stackName);
}

applyNagSuppressions(main, waf, config);
Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

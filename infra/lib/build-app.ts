import { App, Tags, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CubeOnAwsConfig } from './config';
import { CubeStack } from './cube-stack';
import { applyNagSuppressions } from './nag-suppressions';
import { CubeWafStack } from './waf-stack';

/** Adds the Cube stacks (and the WAF stack when security.waf is on) to the app, with cdk-nag checks. */
export function buildApp(app: App, config: CubeOnAwsConfig, account = process.env.CDK_DEFAULT_ACCOUNT): { main: CubeStack; waf?: CubeWafStack } {
  const waf = config.security.waf
    ? new CubeWafStack(app, `${config.stackName}-Waf`, {
        config,
        env: { account, region: 'us-east-1' },
        crossRegionReferences: true,
        description: 'Cube on AWS - WAF web ACL for CloudFront',
      })
    : undefined;

  const main = new CubeStack(app, config.stackName, {
    config,
    webAclArn: waf?.webAclArn,
    env: { account, region: config.region },
    crossRegionReferences: !!waf,
    description: 'Cube on AWS - Cube Core semantic layer on ECS Fargate (API, refresh worker, Cube Store, MCP)',
  });
  if (waf) main.addStackDependency(waf);

  for (const s of waf ? [waf, main] : [main]) {
    Tags.of(s).add('Project', 'cube-on-aws');
    Tags.of(s).add('Environment', config.environment);
    Tags.of(s).add('CubeStack', config.stackName);
  }

  applyNagSuppressions(main, waf, config);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return { main, waf };
}

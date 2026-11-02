import { ArnFormat, CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { CubeOnAwsConfig } from './config';

/**
 * AWS WAF web ACL for the CloudFront distribution. CloudFront-scoped web ACLs must live in
 * us-east-1, so this is a separate stack referenced cross-region by the main stack.
 */
export class CubeWafStack extends Stack {
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: StackProps & { config: CubeOnAwsConfig }) {
    super(scope, id, props);
    const { config } = props;
    const isProd = config.environment === 'prod';

    const managed = (name: string, priority: number, overrides: string[] = []): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ruleActionOverrides: overrides.map((r) => ({ name: r, actionToUse: { count: {} } })),
        },
      },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: name },
    });

    const rules: wafv2.CfnWebACL.RuleProperty[] = [
      managed('AWSManagedRulesAmazonIpReputationList', 0),
      // Cube JSON queries can be long (GET ?query=... and POST bodies): count instead of block size rules.
      managed('AWSManagedRulesCommonRuleSet', 1, ['SizeRestrictions_QUERYSTRING', 'SizeRestrictions_BODY']),
      managed('AWSManagedRulesKnownBadInputsRuleSet', 2),
      {
        name: 'RateLimitPerIp',
        priority: 3,
        action: { block: {} },
        statement: { rateBasedStatement: { limit: config.access.rateLimitPer5Min, aggregateKeyType: 'IP' } },
        visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'RateLimitPerIp' },
      },
    ];

    let defaultAction: wafv2.CfnWebACL.DefaultActionProperty = { allow: {} };
    if (config.access.allowedCidrs.length > 0) {
      const v4 = config.access.allowedCidrs.filter((c) => !c.includes(':'));
      const v6 = config.access.allowedCidrs.filter((c) => c.includes(':'));
      const sets: wafv2.CfnWebACL.StatementProperty[] = [];
      if (v4.length) {
        const s = new wafv2.CfnIPSet(this, 'AllowedIpv4', { scope: 'CLOUDFRONT', ipAddressVersion: 'IPV4', addresses: v4 });
        sets.push({ ipSetReferenceStatement: { arn: s.attrArn } });
      }
      if (v6.length) {
        const s = new wafv2.CfnIPSet(this, 'AllowedIpv6', { scope: 'CLOUDFRONT', ipAddressVersion: 'IPV6', addresses: v6 });
        sets.push({ ipSetReferenceStatement: { arn: s.attrArn } });
      }
      rules.push({
        name: 'AllowListedIps',
        priority: 10,
        action: { allow: {} },
        statement: sets.length === 1 ? sets[0] : { orStatement: { statements: sets } },
        visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'AllowListedIps' },
      });
      defaultAction = { block: {} };
    }

    const acl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction,
      rules,
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: `${config.stackName}-waf` },
    });

    // WAF log group names must start with "aws-waf-logs-".
    const logGroup = new logs.LogGroup(this, 'WafLogs', {
      logGroupName: `aws-waf-logs-${config.stackName}`,
      retention: isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
      resourceArn: acl.attrArn,
      logDestinationConfigs: [Stack.of(this).formatArn({ service: 'logs', resource: 'log-group', resourceName: logGroup.logGroupName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      redactedFields: [{ singleHeader: { Name: 'authorization' } }],
    });

    this.webAclArn = acl.attrArn;
    new CfnOutput(this, 'WebAclArn', { value: acl.attrArn });
  }
}

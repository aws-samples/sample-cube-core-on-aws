import { Stack, Validations } from 'aws-cdk-lib';
import { CubeOnAwsConfig } from './config';

const ack = (stack: Stack, rules: { id: string; reason: string }[]) => {
  for (const r of rules) Validations.of(stack).acknowledge({ ...r, id: `AwsSolutions::${r.id}` });
};

/** Documented, reviewed exceptions to cdk-nag AwsSolutions rules. */
export function applyNagSuppressions(main: Stack, waf: Stack | undefined, config: CubeOnAwsConfig): void {
  const glueDb = `cube_demo_${config.stackName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  ack(main, [
    { id: 'AwsSolutions-L1', reason: 'Runtime of CDK-provided helper Lambdas is managed by the CDK/construct library; the MCP Lambda uses Node.js 22.' },
    { id: 'AwsSolutions-SMG4', reason: 'CUBEJS_API_SECRET is an HMAC signing key; rotating it invalidates all issued JWTs, so it is rotated deliberately (see README). For enterprise SSO use cube.jwt.jwkUrl (e.g. Amazon Cognito) instead.' },
    { id: 'AwsSolutions-ECS2', reason: 'Only non-secret configuration is passed as environment variables; secrets are injected from AWS Secrets Manager.' },
    { id: 'AwsSolutions-CFR1', reason: 'Geo restriction is configurable via access.geoAllowList; default is open for a global API protected by WAF and JWT.' },
    { id: 'AwsSolutions-CFR4', reason: 'With the default *.cloudfront.net domain CloudFront negotiates TLS 1.2+ with modern clients but cannot enforce a minimum policy; set access.customDomain to enforce TLSv1.2_2021.' },
    { id: 'AwsSolutions-CFR5', reason: 'Origin is a CloudFront VPC origin (private ALB inside the VPC); traffic never traverses the public internet.' },
    { id: 'AwsSolutions-ELB2', reason: 'ALB access logging is enabled; NLB (optional SQL API) uses plain TCP listeners for which access logs are not available.' },
    { id: 'AwsSolutions-EC23', reason: 'Ingress is limited to the CloudFront origin-facing managed prefix list, specific security groups, or the configured sqlApi.allowedCidrs.' },
  ]);
  // Only when the operator turns these off on purpose (config.json security.* or deploy.sh --no-*).
  if (!config.security.waf) {
    ack(main, [{ id: 'AwsSolutions-CFR2', reason: 'security.waf=false was set by the operator (e.g. a central WAF / Firewall Manager policy already covers this distribution). Every API call still needs a valid Cube JWT.' }]);
  }
  if (!config.security.vpcFlowLogs) {
    ack(main, [{ id: 'AwsSolutions-VPC7', reason: 'security.vpcFlowLogs=false was set by the operator (e.g. flow logs are already collected centrally for this VPC).' }]);
  }
  // Granular IAM findings: S3/KMS grant helpers (bucket.grantRead/grantReadWrite) emit
  // wildcard actions/object ARNs, all scoped to buckets and keys created by this stack.
  const iam5 = [
    'Action::kms:GenerateDataKey*', 'Action::kms:ReEncrypt*',
    'Action::s3:Abort*', 'Action::s3:DeleteObject*', 'Action::s3:GetBucket*', 'Action::s3:GetObject*', 'Action::s3:List*',
    'Resource::*',
    'Resource::<AthenaDemoAthenaResultsA3AEB9E5.Arn>/*',
    'Resource::<AthenaDemoDemoDataB5303A91.Arn>/*',
    'Resource::<Conf71DED7A8.Arn>/*',
    'Resource::<Conf71DED7A8.Arn>/conf/*',
    'Resource::<CubeStoreStorage4C10AA61.Arn>/*',
    `Resource::arn:aws:glue:${main.region}:${main.account}:table/${glueDb}/*`,
    `Resource::arn:aws:s3:::cdk-hnb659fds-assets-${main.account}-${main.region}/*`,
  ];
  for (const f of iam5) {
    Validations.of(main).acknowledge({
      id: `AwsSolutions::AwsSolutions-IAM5[${f}]`,
      reason: 'Scoped to resources owned by this stack (S3 object keys, the stack CMK, the demo Glue database, the CDK asset bucket); Resource::* only for APIs without resource-level permissions (X-Ray, ECR auth token, ENI management).',
    });
  }
  for (const policy of ['AWSLambdaBasicExecutionRole', 'AWSLambdaVPCAccessExecutionRole']) {
    Validations.of(main).acknowledge({
      id: `AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/${policy}]`,
      reason: 'Standard AWS managed Lambda execution policies (CloudWatch Logs / VPC ENI) used by the MCP Lambda and CDK helper functions.',
    });
  }

  if (waf) ack(waf, [
    { id: 'AwsSolutions-IAM4', reason: 'CDK cross-region reference helpers use AWS managed policies.' },
    { id: 'AwsSolutions-IAM5', reason: 'CDK cross-region reference helpers need wildcard SSM parameter access under /cdk/exports/.' },
    { id: 'AwsSolutions-L1', reason: 'CDK-provided helper Lambda runtime is managed by CDK.' },
  ]);
}

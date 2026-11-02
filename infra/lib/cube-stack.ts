import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { CubeOnAwsConfig, PATHS } from './config';
import { AthenaDemo } from './constructs/athena-demo';
import { CubeServices } from './constructs/cube-services';
import { CubeStore } from './constructs/cubestore';
import { Foundation } from './constructs/foundation';
import { ImageMirror } from './constructs/images';
import { McpEndpoint } from './constructs/mcp';

export const AWS_CLI_IMAGE_TAG = '2.38.6';

export interface CubeStackProps extends StackProps {
  config: CubeOnAwsConfig;
  webAclArn: string;
}

/** Deterministic hash of a folder's contents (relative paths + bytes). */
function hashDir(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        h.update(path.relative(dir, p));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

export class CubeStack extends Stack {
  constructor(scope: Construct, id: string, props: CubeStackProps) {
    super(scope, id, props);
    const { config } = props;

    const foundation = new Foundation(this, 'Foundation', { config });
    const { vpc, key } = foundation;

    // ---- Images (mirrored into private ECR)
    const mirror = new ImageMirror(this, 'Images', { removalPolicy: foundation.removalPolicy });
    const cubeImage = mirror.mirror('Cube', 'docker.io/cubejs/cube', config.cubeVersion);
    const cubestoreImage = mirror.mirror('CubeStore', 'docker.io/cubejs/cubestore', config.cubeVersion);
    const awsCliImage = mirror.mirror('AwsCli', 'public.ecr.aws/aws-cli/aws-cli', AWS_CLI_IMAGE_TAG);

    // ---- Secrets
    const apiSecret = new secretsmanager.Secret(this, 'ApiSecret', {
      description: 'CUBEJS_API_SECRET: HS256 key used to sign/verify Cube JWTs',
      encryptionKey: key,
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: foundation.removalPolicy,
    });
    const sqlSecret = config.sqlApi.enabled
      ? new secretsmanager.Secret(this, 'SqlApiCredentials', {
          description: 'Cube SQL API (Postgres protocol) user and password',
          encryptionKey: key,
          generateSecretString: {
            secretStringTemplate: JSON.stringify({ username: 'cube' }),
            generateStringKey: 'password',
            passwordLength: 32,
            excludePunctuation: true,
          },
          removalPolicy: foundation.removalPolicy,
        })
      : undefined;

    // ---- Cube configuration + data model (./cube) -> S3
    const confBucket = foundation.dataBucket(this, 'Conf');
    const confPrefix = 'conf/';
    const confDeployment = new s3deploy.BucketDeployment(this, 'DeployCubeConf', {
      sources: [s3deploy.Source.asset(PATHS.cubeConf)],
      destinationBucket: confBucket,
      destinationKeyPrefix: confPrefix,
      prune: true,
      memoryLimit: 512,
    });

    // ---- Data source
    let dataSourceEnv: Record<string, string> = { ...config.dataSource.env };
    let athenaDemo: AthenaDemo | undefined;
    if (config.dataSource.type === 'athena-demo') {
      athenaDemo = new AthenaDemo(this, 'AthenaDemo', { foundation, stackName: config.stackName });
      dataSourceEnv = { ...athenaDemo.env, ...dataSourceEnv };
    }

    // ---- ECS cluster + private DNS for Cube Store discovery
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'Namespace', {
      name: `${config.stackName.toLowerCase()}.cube.internal`,
      vpc,
      description: 'Cube internal service discovery',
    });

    const cubestore = new CubeStore(this, 'CubeStore', { config, foundation, cluster, namespace, image: cubestoreImage });

    // ALB security group: only CloudFront origin-facing servers (VPC origin) can reach port 80.
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, description: 'Cube internal ALB', allowAllOutbound: false });
    const cfPrefixList = ec2.PrefixList.fromLookup(this, 'CloudFrontOriginFacing', {
      prefixListName: 'com.amazonaws.global.cloudfront.origin-facing',
    });
    albSg.addIngressRule(ec2.Peer.prefixList(cfPrefixList.prefixListId), ec2.Port.tcp(80), 'CloudFront VPC origin');

    const services = new CubeServices(this, 'Cube', {
      config,
      foundation,
      cluster,
      cubestore,
      cubeImage,
      awsCliImage,
      apiSecret,
      sqlPasswordSecret: sqlSecret,
      confBucket,
      confPrefix,
      confHash: hashDir(PATHS.cubeConf),
      dataSourceEnv,
      albSecurityGroup: albSg,
    });
    services.apiService.node.addDependency(confDeployment);
    services.refreshService.node.addDependency(confDeployment);
    albSg.addEgressRule(services.apiSecurityGroup, ec2.Port.tcp(4000), 'ALB to Cube API');
    athenaDemo?.grantQuery(services.taskRole);
    key.grantDecrypt(services.taskRole);

    const mcp = config.mcp.enabled
      ? new McpEndpoint(this, 'Mcp', { foundation, alb: services.alb, listener: services.listener, albSecurityGroup: albSg })
      : undefined;

    // ---- CloudFront (HTTPS, WAF) -> VPC origin -> internal ALB
    const domain = config.access.customDomain;
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Cube API (${config.stackName})`,
      defaultBehavior: {
        origin: origins.VpcOrigin.withApplicationLoadBalancer(services.alb, {
          httpPort: 80,
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          readTimeout: Duration.seconds(60),
          keepaliveTimeout: Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      webAclId: props.webAclArn,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      enableLogging: true,
      logBucket: foundation.logsBucket,
      logFilePrefix: 'cloudfront/',
      geoRestriction: config.access.geoAllowList.length ? cloudfront.GeoRestriction.allowlist(...config.access.geoAllowList) : undefined,
      ...(domain.domainName
        ? {
            domainNames: [domain.domainName],
            certificate: acm.Certificate.fromCertificateArn(this, 'Cert', domain.certificateArn),
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
    });
    const baseUrl = domain.domainName ? `https://${domain.domainName}` : `https://${distribution.distributionDomainName}`;

    // ---- Monitoring
    const topic = new sns.Topic(this, 'Alarms', { masterKey: key, displayName: `${config.stackName} alarms`, enforceSSL: true });
    if (config.alarmEmail) topic.addSubscription(new subs.EmailSubscription(config.alarmEmail));
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, desc: string, periods = 3) => {
      const a = new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods: periods,
        alarmDescription: desc,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });
      a.addAlarmAction(new cwActions.SnsAction(topic));
      a.addOkAction(new cwActions.SnsAction(topic));
    };
    alarm('Api5xx', services.apiTargetGroup.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: Duration.minutes(5), statistic: 'Sum' }), 10, 'Cube API returns 5xx');
    alarm('ApiUnhealthy', services.apiTargetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1), statistic: 'Maximum' }), 1, 'Unhealthy Cube API tasks', 5);
    alarm('ApiLatency', services.apiTargetGroup.metrics.targetResponseTime({ period: Duration.minutes(5), statistic: 'p95' }), 10, 'Cube API p95 latency >= 10s');
    alarm('ApiCpu', services.apiService.metricCpuUtilization({ period: Duration.minutes(5) }), 85, 'Cube API CPU >= 85%');
    for (const [i, s] of cubestore.services.entries()) {
      alarm(`CubeStoreMemory${i}`, s.metricMemoryUtilization({ period: Duration.minutes(5) }), 90, `${s.node.id}: memory >= 90%`);
    }
    if (mcp) alarm('McpErrors', mcp.fn.metricErrors({ period: Duration.minutes(5) }), 5, 'MCP Lambda errors');

    // ---- Outputs
    new CfnOutput(this, 'CubeUrl', { value: baseUrl, description: 'Base URL (CloudFront, HTTPS)' });
    new CfnOutput(this, 'CubeRestApi', { value: `${baseUrl}/cubejs-api/v1`, description: 'Cube REST API endpoint' });
    if (mcp) new CfnOutput(this, 'McpUrl', { value: `${baseUrl}/mcp`, description: 'Remote MCP endpoint (Streamable HTTP)' });
    new CfnOutput(this, 'ApiSecretArn', { value: apiSecret.secretArn, description: 'Secret used to sign Cube JWTs (scripts/gen-token.mjs)' });
    new CfnOutput(this, 'ConfBucketName', { value: confBucket.bucketName });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'AlarmTopicArn', { value: topic.topicArn });
    if (services.sqlApiEndpoint && sqlSecret) {
      new CfnOutput(this, 'SqlApiEndpoint', { value: services.sqlApiEndpoint, description: 'Internal Postgres-compatible SQL API' });
      new CfnOutput(this, 'SqlApiSecretArn', { value: sqlSecret.secretArn });
    }
  }
}

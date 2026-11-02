import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { CubeOnAwsConfig } from '../config';

export interface FoundationProps {
  config: CubeOnAwsConfig;
}

/**
 * Shared foundation: customer managed KMS key, VPC (with flow logs and VPC endpoints),
 * and the access-log bucket used by S3, ALB and CloudFront.
 */
export class Foundation extends Construct {
  readonly key: kms.Key;
  readonly vpc: ec2.IVpc;
  readonly logsBucket: s3.Bucket;
  readonly isProd: boolean;
  readonly removalPolicy: RemovalPolicy;
  readonly logRetention: logs.RetentionDays;

  constructor(scope: Construct, id: string, props: FoundationProps) {
    super(scope, id);
    const { config } = props;
    const stack = Stack.of(this);
    this.isProd = config.environment === 'prod';
    this.removalPolicy = this.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    this.logRetention = this.isProd ? logs.RetentionDays.ONE_YEAR : logs.RetentionDays.ONE_MONTH;

    // ---- KMS: one CMK (with automatic rotation) for data at rest: S3, logs, secrets, SNS.
    this.key = new kms.Key(this, 'Key', {
      alias: `alias/${config.stackName}`,
      description: `Cube on AWS (${config.stackName}) data encryption key`,
      enableKeyRotation: true,
      removalPolicy: this.removalPolicy,
      pendingWindow: Duration.days(this.isProd ? 30 : 7),
    });
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${stack.partition}:logs:${stack.region}:${stack.account}:*` },
        },
      }),
    );
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublishToEncryptedSns',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': stack.account } },
      }),
    );

    // ---- Access logs bucket (SSE-S3 is required by S3 server access logging and ALB access logs;
    // ACLs are required by CloudFront standard logging).
    this.logsBucket = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: this.isProd,
      lifecycleRules: [
        { expiration: Duration.days(this.isProd ? 365 : 90), noncurrentVersionExpiration: Duration.days(30) },
      ],
      removalPolicy: this.removalPolicy,
      autoDeleteObjects: !this.isProd,
    });

    // ---- VPC
    if (config.network.vpcId) {
      this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: config.network.vpcId });
    } else {
      const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogs', {
        encryptionKey: this.key,
        retention: this.logRetention,
        removalPolicy: this.removalPolicy,
      });
      this.vpc = new ec2.Vpc(this, 'Vpc', {
        ipAddresses: ec2.IpAddresses.cidr(config.network.vpcCidr),
        maxAzs: config.network.maxAzs,
        natGateways: this.isProd ? Math.max(config.network.natGateways, config.network.maxAzs) : config.network.natGateways,
        restrictDefaultSecurityGroup: true,
        subnetConfiguration: [
          { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24, mapPublicIpOnLaunch: false },
          { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        ],
        flowLogs: {
          all: { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup), trafficType: ec2.FlowLogTrafficType.ALL },
        },
      });
    }

    if (config.network.vpcEndpoints) {
      const subnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };
      this.vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3, subnets: [subnets] });
      const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
        EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
        EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      };
      if (config.dataSource.type === 'athena-demo') {
        interfaceEndpoints.Athena = ec2.InterfaceVpcEndpointAwsService.ATHENA;
        interfaceEndpoints.Glue = ec2.InterfaceVpcEndpointAwsService.GLUE;
      }
      for (const [name, service] of Object.entries(interfaceEndpoints)) {
        this.vpc.addInterfaceEndpoint(`${name}Endpoint`, { service, subnets, privateDnsEnabled: true });
      }
    }
  }

  /** Bucket for application data: SSE-KMS with bucket keys, TLS only, versioned, access logged. */
  dataBucket(scope: Construct, id: string, extra: Partial<s3.BucketProps> = {}): s3.Bucket {
    return new s3.Bucket(scope, id, {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: `s3/${scope.node.id}-${id}/`,
      removalPolicy: this.removalPolicy,
      autoDeleteObjects: !this.isProd,
      ...extra,
    });
  }

  logGroup(scope: Construct, id: string): logs.LogGroup {
    return new logs.LogGroup(scope, id, {
      encryptionKey: this.key,
      retention: this.logRetention,
      removalPolicy: this.removalPolicy,
    });
  }
}

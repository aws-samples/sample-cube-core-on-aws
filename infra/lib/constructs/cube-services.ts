import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { CubeOnAwsConfig } from '../config';
import { CUBESTORE_HTTP_PORT, CubeStore } from './cubestore';
import { Foundation } from './foundation';
import { MirroredImage } from './images';

const CUBE_PORT = 4000;
export const SQL_API_PORT = 15432;
const CUBE_UID = '1000:1000';

export interface CubeServicesProps {
  config: CubeOnAwsConfig;
  foundation: Foundation;
  cluster: ecs.Cluster;
  cubestore: CubeStore;
  cubeImage: MirroredImage;
  awsCliImage: MirroredImage;
  apiSecret: secretsmanager.ISecret;
  sqlPasswordSecret?: secretsmanager.ISecret;
  /** Bucket + prefix with cube.js and model/ (synced into the containers at start-up). */
  confBucket: s3.IBucket;
  confPrefix: string;
  /** Hash of the conf folder: changes trigger a rolling deployment. */
  confHash: string;
  dataSourceEnv: Record<string, string>;
  /** Security group of the CloudFront VPC origin side (ALB). */
  albSecurityGroup: ec2.SecurityGroup;
}

/**
 * Cube API instances (behind an internal ALB, auto scaled) and the Cube refresh worker.
 * Containers run as a non-root user with a read-only root filesystem; the data model is
 * pulled from S3 by an init container, so no custom image build (and no Docker) is needed.
 */
export class CubeServices extends Construct {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly listener: elbv2.ApplicationListener;
  readonly apiService: ecs.FargateService;
  readonly refreshService: ecs.FargateService;
  readonly apiTargetGroup: elbv2.ApplicationTargetGroup;
  readonly taskRole: iam.Role;
  readonly apiSecurityGroup: ec2.SecurityGroup;
  readonly sqlApiEndpoint?: string;

  constructor(scope: Construct, id: string, props: CubeServicesProps) {
    super(scope, id);
    const { config, foundation, cluster, cubestore } = props;
    const vpc = foundation.vpc;
    const privateSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Cube API and refresh worker tasks',
    });
    props.confBucket.grantRead(this.taskRole, `${props.confPrefix}*`);

    this.apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSg', { vpc, description: 'Cube API tasks', allowAllOutbound: true });
    const refreshSg = new ec2.SecurityGroup(this, 'RefreshSg', { vpc, description: 'Cube refresh worker', allowAllOutbound: true });
    cubestore.allowClient(this.apiSecurityGroup);
    cubestore.allowClient(refreshSg);

    const env: Record<string, string> = {
      NODE_ENV: 'production',
      CUBEJS_DEV_MODE: 'false',
      CUBEJS_TELEMETRY: 'false',
      CUBEJS_LOG_LEVEL: 'info',
      CUBEJS_CUBESTORE_HOST: cubestore.routerHost,
      CUBEJS_CUBESTORE_PORT: `${CUBESTORE_HTTP_PORT}`,
      CUBEJS_CACHE_AND_QUEUE_DRIVER: 'cubestore',
      CUBE_CONF_SHA256: props.confHash,
      ...props.dataSourceEnv,
      ...config.cube.extraEnv,
    };
    const jwt = config.cube.jwt;
    if (jwt.jwkUrl) {
      Object.assign(env, {
        CUBEJS_JWK_URL: jwt.jwkUrl,
        CUBEJS_JWT_ALGS: jwt.algorithms || 'RS256',
        ...(jwt.issuer ? { CUBEJS_JWT_ISSUER: jwt.issuer } : {}),
        ...(jwt.audience ? { CUBEJS_JWT_AUDIENCE: jwt.audience } : {}),
        ...(jwt.claimsNamespace ? { CUBEJS_JWT_CLAIMS_NAMESPACE: jwt.claimsNamespace } : {}),
      });
    }

    const secrets: Record<string, ecs.Secret> = {
      CUBEJS_API_SECRET: ecs.Secret.fromSecretsManager(props.apiSecret),
    };
    if (config.dataSource.secretArn) {
      const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'DbSecret', config.dataSource.secretArn);
      for (const [envName, jsonKey] of Object.entries(config.dataSource.secretEnv)) {
        secrets[envName] = ecs.Secret.fromSecretsManager(dbSecret, jsonKey);
      }
    }

    const logGroup = foundation.logGroup(this, 'Logs');

    const makeTaskDef = (name: string, size: { cpu: number; memoryMiB: number }, extraEnv: Record<string, string>, extraSecrets: Record<string, ecs.Secret>, ports: number[]) => {
      const taskDef = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        cpu: size.cpu,
        memoryLimitMiB: size.memoryMiB,
        taskRole: this.taskRole,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
        volumes: [{ name: 'conf' }, { name: 'tmp' }],
      });
      taskDef.node.addDependency(props.cubeImage.copy, props.awsCliImage.copy);

      const init = taskDef.addContainer('conf-sync', {
        image: props.awsCliImage.image,
        essential: false,
        entryPoint: ['/bin/sh', '-c'],
        command: [
          `aws s3 sync "s3://${props.confBucket.bucketName}/${props.confPrefix}" /cube/conf --delete --only-show-errors --no-progress` +
            ` && chown -R ${CUBE_UID} /cube/conf && chmod 1777 /tmp-cube && echo "conf synced: $CUBE_CONF_SHA256"`,
        ],
        environment: { CUBE_CONF_SHA256: props.confHash, AWS_REGION: props.confBucket.stack.region },
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: `${name}-init` }),
        memoryReservationMiB: 128,
      });
      init.addMountPoints(
        { containerPath: '/cube/conf', sourceVolume: 'conf', readOnly: false },
        { containerPath: '/tmp-cube', sourceVolume: 'tmp', readOnly: false },
      );

      const cube = taskDef.addContainer('cube', {
        image: props.cubeImage.image,
        user: CUBE_UID,
        readonlyRootFilesystem: true,
        environment: { ...env, ...extraEnv },
        secrets: { ...secrets, ...extraSecrets },
        portMappings: ports.map((containerPort) => ({ containerPort })),
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name, mode: ecs.AwsLogDriverMode.NON_BLOCKING }),
        stopTimeout: Duration.seconds(30),
      });
      cube.addMountPoints(
        { containerPath: '/cube/conf', sourceVolume: 'conf', readOnly: false },
        { containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false },
      );
      cube.addContainerDependencies({ container: init, condition: ecs.ContainerDependencyCondition.SUCCESS });
      return taskDef;
    };

    // ---- Cube API instances
    const apiExtraEnv: Record<string, string> = {};
    const apiExtraSecrets: Record<string, ecs.Secret> = {};
    const apiPorts = [CUBE_PORT];
    if (config.sqlApi.enabled && props.sqlPasswordSecret) {
      apiExtraEnv.CUBEJS_PG_SQL_PORT = `${SQL_API_PORT}`;
      apiExtraSecrets.CUBEJS_SQL_USER = ecs.Secret.fromSecretsManager(props.sqlPasswordSecret, 'username');
      apiExtraSecrets.CUBEJS_SQL_PASSWORD = ecs.Secret.fromSecretsManager(props.sqlPasswordSecret, 'password');
      apiPorts.push(SQL_API_PORT);
    }
    const apiTask = makeTaskDef('cube-api', config.cube.api, apiExtraEnv, apiExtraSecrets, apiPorts);
    this.apiService = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTask,
      desiredCount: config.cube.api.minCount,
      securityGroups: [this.apiSecurityGroup],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: Duration.seconds(120),
      enableExecuteCommand: config.cube.enableExecuteCommand,
    });
    for (const s of cubestore.services) this.apiService.node.addDependency(s);

    // ---- Refresh worker (builds pre-aggregations into Cube Store)
    const refreshTask = makeTaskDef('cube-refresh-worker', config.cube.refreshWorker, { CUBEJS_REFRESH_WORKER: 'true' }, {}, []);
    this.refreshService = new ecs.FargateService(this, 'RefreshService', {
      cluster,
      taskDefinition: refreshTask,
      desiredCount: 1,
      securityGroups: [refreshSg],
      vpcSubnets: privateSubnets,
      assignPublicIp: false,
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: config.cube.enableExecuteCommand,
    });
    for (const s of cubestore.services) this.refreshService.node.addDependency(s);

    // ---- Internal ALB: only reachable from CloudFront (VPC origin) and in-VPC clients we allow.
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      vpcSubnets: privateSubnets,
      securityGroup: props.albSecurityGroup,
      dropInvalidHeaderFields: true,
      deletionProtection: foundation.isProd,
      idleTimeout: Duration.seconds(120),
      desyncMitigationMode: elbv2.DesyncMitigationMode.DEFENSIVE,
    });
    this.alb.logAccessLogs(foundation.logsBucket, 'alb');
    this.apiSecurityGroup.addIngressRule(props.albSecurityGroup, ec2.Port.tcp(CUBE_PORT), 'ALB to Cube API');

    this.listener = this.alb.addListener('Http', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, { contentType: 'application/json', messageBody: '{"error":"Not found"}' }),
    });
    this.apiTargetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTargets', {
      vpc,
      port: CUBE_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.apiService.loadBalancerTarget({ containerName: 'cube', containerPort: CUBE_PORT })],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: { path: '/livez', healthyHttpCodes: '200', interval: Duration.seconds(15), healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
    });
    // Only the Cube REST API and health probes are routed; Playground and everything else return 404.
    this.listener.addTargetGroups('CubeApi', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/cubejs-api/*', '/livez', '/readyz'])],
      targetGroups: [this.apiTargetGroup],
    });

    const scaling = this.apiService.autoScaleTaskCount({ minCapacity: config.cube.api.minCount, maxCapacity: config.cube.api.maxCount });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60, scaleOutCooldown: Duration.seconds(60), scaleInCooldown: Duration.seconds(300) });
    scaling.scaleOnMemoryUtilization('Memory', { targetUtilizationPercent: 75 });
    scaling.scaleOnRequestCount('Requests', { requestsPerTarget: 600, targetGroup: this.apiTargetGroup });

    // ---- Optional SQL API (Postgres wire protocol) on an internal NLB.
    if (config.sqlApi.enabled) {
      const nlbSg = new ec2.SecurityGroup(this, 'SqlNlbSg', { vpc, description: 'Cube SQL API NLB', allowAllOutbound: false });
      for (const cidr of config.sqlApi.allowedCidrs) nlbSg.addIngressRule(cidr.includes(':') ? ec2.Peer.ipv6(cidr) : ec2.Peer.ipv4(cidr), ec2.Port.tcp(SQL_API_PORT), 'SQL API clients');
      nlbSg.addEgressRule(this.apiSecurityGroup, ec2.Port.tcp(SQL_API_PORT), 'NLB to Cube SQL API');
      this.apiSecurityGroup.addIngressRule(nlbSg, ec2.Port.tcp(SQL_API_PORT), 'SQL NLB to Cube');
      const nlb = new elbv2.NetworkLoadBalancer(this, 'SqlNlb', {
        vpc,
        internetFacing: false,
        vpcSubnets: privateSubnets,
        securityGroups: [nlbSg],
        crossZoneEnabled: true,
        deletionProtection: foundation.isProd,
      });
      nlb.addListener('Sql', { port: SQL_API_PORT }).addTargets('Cube', {
        port: SQL_API_PORT,
        targets: [this.apiService.loadBalancerTarget({ containerName: 'cube', containerPort: SQL_API_PORT })],
        deregistrationDelay: Duration.seconds(30),
      });
      this.sqlApiEndpoint = `${nlb.loadBalancerDnsName}:${SQL_API_PORT}`;
    }
  }
}

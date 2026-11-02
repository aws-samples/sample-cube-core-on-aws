import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import { Construct } from 'constructs';
import { CubeOnAwsConfig } from '../config';
import { Foundation } from './foundation';
import { MirroredImage } from './images';

export const CUBESTORE_HTTP_PORT = 3030;
const META_PORT = 9999;
const WORKER_PORT = 10001;

export interface CubeStoreProps {
  config: CubeOnAwsConfig;
  foundation: Foundation;
  cluster: ecs.Cluster;
  namespace: servicediscovery.PrivateDnsNamespace;
  image: MirroredImage;
}

/**
 * Cube Store cluster (pre-aggregation storage + cache/queue): one router and N workers,
 * each worker an ECS service with a stable Cloud Map DNS name. Persistent state lives in
 * S3 (accessed with the ECS task role, no static keys); local disks are just caches.
 */
export class CubeStore extends Construct {
  readonly securityGroup: ec2.SecurityGroup;
  readonly routerHost: string;
  readonly bucket: s3.Bucket;
  readonly services: ecs.FargateService[] = [];

  constructor(scope: Construct, id: string, props: CubeStoreProps) {
    super(scope, id);
    const { config, foundation, cluster, namespace, image } = props;
    const ns = namespace.namespaceName;

    this.bucket = foundation.dataBucket(this, 'Storage', {
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(7), abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });

    this.securityGroup = new ec2.SecurityGroup(this, 'Sg', {
      vpc: foundation.vpc,
      description: 'Cube Store router and workers',
      allowAllOutbound: true,
    });
    // Router <-> workers traffic stays within the Cube Store security group.
    this.securityGroup.addIngressRule(this.securityGroup, ec2.Port.tcp(META_PORT), 'Cube Store metastore');
    this.securityGroup.addIngressRule(this.securityGroup, ec2.Port.tcp(WORKER_PORT), 'Cube Store workers');

    const role = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Cube Store tasks: read/write the Cube Store S3 bucket only',
    });
    this.bucket.grantReadWrite(role);

    const logGroup = foundation.logGroup(this, 'Logs');
    this.routerHost = `cubestore-router.${ns}`;
    const workerNames = Array.from({ length: config.cube.cubestoreWorker.count }, (_, i) => `cubestore-worker-${i + 1}`);
    const workersEnv = workerNames.map((n) => `${n}.${ns}:${WORKER_PORT}`).join(',');

    const commonEnv: Record<string, string> = {
      CUBESTORE_S3_BUCKET: this.bucket.bucketName,
      CUBESTORE_S3_REGION: this.bucket.stack.region,
      CUBESTORE_S3_SUB_PATH: 'cubestore',
      CUBESTORE_WORKERS: workersEnv,
      CUBESTORE_DATA_DIR: '/cube/data',
      CUBESTORE_TELEMETRY: 'false',
      CUBESTORE_LOG_LEVEL: 'info',
    };

    const addService = (name: string, size: { cpu: number; memoryMiB: number }, storageGiB: number, env: Record<string, string>, ports: number[]) => {
      const taskDef = new ecs.FargateTaskDefinition(this, `${name}Task`, {
        cpu: size.cpu,
        memoryLimitMiB: size.memoryMiB,
        ephemeralStorageGiB: storageGiB,
        taskRole: role,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      });
      taskDef.node.addDependency(image.copy);
      taskDef.addContainer('cubestore', {
        image: image.image,
        environment: { ...commonEnv, ...env },
        portMappings: ports.map((containerPort) => ({ containerPort })),
        logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: name, mode: ecs.AwsLogDriverMode.NON_BLOCKING }),
        stopTimeout: Duration.seconds(60),
        ulimits: [{ name: ecs.UlimitName.NOFILE, softLimit: 65536, hardLimit: 65536 }],
      });
      const service = new ecs.FargateService(this, `${name}Service`, {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        securityGroups: [this.securityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        assignPublicIp: false,
        // Each node owns a fixed DNS name: never run two copies of the same node.
        minHealthyPercent: 0,
        maxHealthyPercent: 100,
        circuitBreaker: { enable: true, rollback: true },
        cloudMapOptions: { cloudMapNamespace: namespace, name, dnsRecordType: servicediscovery.DnsRecordType.A, dnsTtl: Duration.seconds(10) },
        enableExecuteCommand: config.cube.enableExecuteCommand,
      });
      // On stack delete, stop Cube Store before the bucket is emptied; otherwise running
      // nodes keep writing and the bucket delete fails with "bucket not empty".
      const autoDelete = this.bucket.node.tryFindChild('AutoDeleteObjectsCustomResource');
      if (autoDelete) service.node.addDependency(autoDelete);
      this.services.push(service);
      return service;
    };

    const router = addService('cubestore-router', config.cube.cubestoreRouter, 30, {
      CUBESTORE_SERVER_NAME: `${this.routerHost}:${META_PORT}`,
      CUBESTORE_META_PORT: `${META_PORT}`,
    }, [CUBESTORE_HTTP_PORT, META_PORT]);

    for (const name of workerNames) {
      const worker = addService(name, config.cube.cubestoreWorker, config.cube.cubestoreWorker.ephemeralStorageGiB, {
        CUBESTORE_SERVER_NAME: `${name}.${ns}:${WORKER_PORT}`,
        CUBESTORE_WORKER_PORT: `${WORKER_PORT}`,
        CUBESTORE_META_ADDR: `${this.routerHost}:${META_PORT}`,
      }, [WORKER_PORT]);
      worker.node.addDependency(router);
    }
  }

  /** Allows Cube API / refresh worker tasks to reach the router. */
  allowClient(sg: ec2.ISecurityGroup): void {
    this.securityGroup.addIngressRule(sg, ec2.Port.tcp(CUBESTORE_HTTP_PORT), 'Cube API/refresh worker to Cube Store router');
  }
}

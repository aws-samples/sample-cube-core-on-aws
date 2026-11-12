import * as path from 'node:path';
import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { PATHS } from '../config';
import { Foundation } from './foundation';

export interface McpProps {
  foundation: Foundation;
  alb: elbv2.ApplicationLoadBalancer;
  listener: elbv2.ApplicationListener;
  albSecurityGroup: ec2.SecurityGroup;
  /** Cube API base URL as seen from inside the VPC (https://<originTls.domainName> or http://<ALB DNS>). */
  apiUrl: string;
  /** ALB listener port (443 with origin TLS, else 80). */
  port: number;
}

/**
 * Remote MCP server (Streamable HTTP) on Lambda, routed by the ALB at /mcp.
 * It holds no credentials: the caller's Cube JWT is forwarded to the Cube API.
 */
export class McpEndpoint extends Construct {
  readonly fn: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: McpProps) {
    super(scope, id);
    const { foundation } = props;

    const sg = new ec2.SecurityGroup(this, 'Sg', { vpc: foundation.vpc, description: 'Cube MCP Lambda', allowAllOutbound: false });
    sg.addEgressRule(props.albSecurityGroup, ec2.Port.tcp(props.port), 'MCP Lambda to internal ALB (Cube API)');
    props.albSecurityGroup.addIngressRule(sg, ec2.Port.tcp(props.port), 'MCP Lambda to Cube API');

    this.fn = new nodejs.NodejsFunction(this, 'Function', {
      description: 'Cube MCP server (Streamable HTTP, stateless)',
      entry: path.join(PATHS.mcpServer, 'src', 'lambda.ts'),
      handler: 'handler',
      projectRoot: PATHS.mcpServer,
      depsLockFilePath: path.join(PATHS.mcpServer, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 50,
      vpc: foundation.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sg],
      environment: {
        CUBE_API_URL: props.apiUrl,
        NODE_OPTIONS: '--enable-source-maps',
      },
      environmentEncryption: foundation.key,
      logGroup: foundation.logGroup(this, 'Logs'),
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        mainFields: ['module', 'main'],
        banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
    });

    props.listener.addTargets('Mcp', {
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/mcp', '/mcp/*'])],
      targets: [new targets.LambdaTarget(this.fn)],
      healthCheck: { enabled: false },
    });
  }
}

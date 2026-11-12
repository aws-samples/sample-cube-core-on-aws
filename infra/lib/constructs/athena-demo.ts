import { Duration, Stack } from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { PATHS } from '../config';
import { Foundation } from './foundation';

/**
 * Ready-to-query demo data source: sample orders CSV in S3, a Glue table on top of it,
 * and a dedicated Athena workgroup with enforced, KMS-encrypted query results.
 */
export class AthenaDemo extends Construct {
  readonly env: Record<string, string>;
  private readonly dataBucket: s3.Bucket;
  private readonly resultsBucket: s3.Bucket;
  private readonly workgroup: athena.CfnWorkGroup;
  private readonly databaseName: string;

  constructor(scope: Construct, id: string, props: { foundation: Foundation; stackName: string }) {
    super(scope, id);
    const { foundation } = props;
    const stack = Stack.of(this);

    this.dataBucket = foundation.dataBucket(this, 'DemoData');
    this.resultsBucket = foundation.dataBucket(this, 'AthenaResults', {
      versioned: false,
      lifecycleRules: [{ expiration: Duration.days(30) }],
    });

    const upload = new s3deploy.BucketDeployment(this, 'UploadSampleData', {
      sources: [s3deploy.Source.asset(PATHS.sampleData)],
      destinationBucket: this.dataBucket,
      destinationKeyPrefix: 'sample-data/',
      memoryLimit: 512,
    });

    this.databaseName = `cube_demo_${props.stackName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId: stack.account,
      databaseInput: { name: this.databaseName, description: 'Cube on AWS demo dataset' },
    });

    const table = new glue.CfnTable(this, 'OrdersTable', {
      catalogId: stack.account,
      databaseName: this.databaseName,
      tableInput: {
        name: 'orders',
        tableType: 'EXTERNAL_TABLE',
        parameters: { classification: 'csv', 'skip.header.line.count': '1', has_encrypted_data: 'true' },
        storageDescriptor: {
          location: `s3://${this.dataBucket.bucketName}/sample-data/orders/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            parameters: { 'field.delim': ',' },
          },
          columns: [
            { name: 'order_id', type: 'bigint' },
            { name: 'created_at', type: 'timestamp' },
            { name: 'status', type: 'string' },
            { name: 'customer_id', type: 'bigint' },
            { name: 'product_category', type: 'string' },
            { name: 'region', type: 'string' },
            { name: 'quantity', type: 'int' },
            { name: 'amount', type: 'double' },
          ],
        },
      },
    });
    table.addResourceDependency(database);
    table.node.addDependency(upload);

    this.workgroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: `${props.stackName}-cube`,
      description: 'Workgroup used by Cube (enforced settings, encrypted results)',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: 10 * 1024 * 1024 * 1024,
        engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
        resultConfiguration: {
          outputLocation: `s3://${this.resultsBucket.bucketName}/results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_KMS', kmsKey: foundation.key.keyArn },
          expectedBucketOwner: stack.account,
        },
      },
    });

    this.env = {
      CUBEJS_DB_TYPE: 'athena',
      CUBEJS_AWS_REGION: stack.region,
      CUBEJS_AWS_ATHENA_WORKGROUP: this.workgroup.name,
      CUBEJS_AWS_S3_OUTPUT_LOCATION: `s3://${this.resultsBucket.bucketName}/results/`,
      CUBE_DEMO_GLUE_DATABASE: this.databaseName,
    };
  }

  /** Least-privilege access for Cube to query the demo dataset through Athena. */
  grantQuery(role: iam.IGrantable): void {
    const stack = Stack.of(this);
    const p = stack.partition;
    role.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults',
          'athena:StopQueryExecution', 'athena:GetWorkGroup',
        ],
        resources: [`arn:${p}:athena:${stack.region}:${stack.account}:workgroup/${this.workgroup.name}`],
      }),
    );
    role.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['glue:GetDatabase', 'glue:GetDatabases', 'glue:GetTable', 'glue:GetTables', 'glue:GetPartition', 'glue:GetPartitions'],
        resources: [
          `arn:${p}:glue:${stack.region}:${stack.account}:catalog`,
          `arn:${p}:glue:${stack.region}:${stack.account}:database/${this.databaseName}`,
          `arn:${p}:glue:${stack.region}:${stack.account}:table/${this.databaseName}/*`,
        ],
      }),
    );
    this.dataBucket.grantRead(role);
    // Athena writes results with the caller's credentials; Cube never deletes them (lifecycle does).
    this.resultsBucket.grantRead(role);
    this.resultsBucket.grantPut(role);
  }
}

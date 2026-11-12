import { Duration } from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { CubeOnAwsConfig } from '../config';
import { Foundation } from './foundation';

export interface SecurityServicesProps {
  config: CubeOnAwsConfig;
  foundation: Foundation;
  alarmTopic: sns.ITopic;
}

/**
 * Account-level audit and threat detection, each behind a config switch (security.*):
 * a multi-Region CloudTrail trail and an Amazon GuardDuty detector. High-severity
 * GuardDuty findings (>= 7) are sent to the alarm topic.
 */
export class SecurityServices extends Construct {
  readonly trail?: cloudtrail.Trail;

  constructor(scope: Construct, id: string, props: SecurityServicesProps) {
    super(scope, id);
    const { config, foundation } = props;

    if (config.security.cloudTrail) {
      const bucket = foundation.dataBucket(this, 'TrailLogs', {
        lifecycleRules: [{ expiration: Duration.days(foundation.isProd ? 365 : 90), noncurrentVersionExpiration: Duration.days(30) }],
      });
      this.trail = new cloudtrail.Trail(this, 'Trail', {
        bucket,
        encryptionKey: foundation.key,
        isMultiRegionTrail: true,
        includeGlobalServiceEvents: true,
        enableFileValidation: true,
      });
    }

    if (config.security.guardDuty) {
      // Only one detector per account and Region is allowed: deploy.sh turns this off when one already exists.
      new guardduty.CfnDetector(this, 'Detector', { enable: true, findingPublishingFrequency: 'FIFTEEN_MINUTES' });
    }

    // Free when idle; also works with a detector you already run (security.guardDuty = false).
    new events.Rule(this, 'GuardDutyHighFindings', {
      description: 'GuardDuty findings with severity >= 7 to the alarm topic',
      eventPattern: {
        source: ['aws.guardduty'],
        detailType: ['GuardDuty Finding'],
        detail: { severity: events.Match.greaterThanOrEqual(7) },
      },
      targets: [new eventTargets.SnsTopic(props.alarmTopic)],
    });
  }
}

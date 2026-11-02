import { RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { DockerImageName, ECRDeployment } from 'cdk-ecr-deployment';
import { Construct } from 'constructs';

export interface MirroredImage {
  image: ecs.ContainerImage;
  /** Resource that finishes copying the image; task definitions must depend on it. */
  copy: Construct;
}

/**
 * Mirrors public images (Docker Hub / ECR Public) into private ECR repositories, so that
 * tasks pull from ECR over VPC endpoints, images are scanned on push, tags are immutable,
 * and deployments do not depend on Docker Hub availability or rate limits.
 * No local Docker is required: the copy runs in a Lambda function during deployment.
 */
export class ImageMirror extends Construct {
  private readonly removalPolicy: RemovalPolicy;

  constructor(scope: Construct, id: string, props: { removalPolicy: RemovalPolicy }) {
    super(scope, id);
    this.removalPolicy = props.removalPolicy;
  }

  mirror(id: string, source: string, tag: string): MirroredImage {
    const repo = new ecr.Repository(this, `${id}Repo`, {
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: this.removalPolicy,
      emptyOnDelete: this.removalPolicy === RemovalPolicy.DESTROY,
      lifecycleRules: [{ description: 'Keep the 10 most recent images', maxImageCount: 10 }],
    });
    const copy = new ECRDeployment(this, `${id}Copy`, {
      src: new DockerImageName(`${source}:${tag}`),
      dest: new DockerImageName(repo.repositoryUriForTag(tag)),
      imageArch: ['amd64'],
    });
    return { image: ecs.ContainerImage.fromEcrRepository(repo, tag), copy };
  }
}

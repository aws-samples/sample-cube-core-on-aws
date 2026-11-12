#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/build-app';
import { loadConfig, securityOverrides } from '../lib/config';

const app = new App();
// `-c security.waf=false` etc. (deploy.sh --no-waf) override config.json.
const config = loadConfig(undefined, securityOverrides((k) => app.node.tryGetContext(k)));
buildApp(app, config);

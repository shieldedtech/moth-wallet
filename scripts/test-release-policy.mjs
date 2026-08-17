// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import {readFileSync} from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const credentialPattern = /(?:SHIELDED_NPMJS_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN)/;

function requirePolicy(condition, message) {
  if (!condition) {
    throw new Error(`release policy violation: ${message}`);
  }
}

for (const packagePath of ['packages/core/package.json', 'packages/tui/package.json', 'packages/cli/package.json']) {
  const packageJson = JSON.parse(readFileSync(new URL(`../${packagePath}`, import.meta.url), 'utf8'));
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };
  requirePolicy(
    !Object.values(dependencies).some((range) => range.startsWith('workspace:')),
    `${packageJson.name} must not publish workspace: dependency ranges`,
  );
}

function job(name) {
  const marker = `  ${name}:`;
  const start = workflow.indexOf(marker);
  requirePolicy(start !== -1, `missing ${name} job`);

  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:/m);
  return nextJob === -1 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextJob);
}

for (const name of ['release', 'canary']) {
  const block = job(name);
  requirePolicy(block.includes('id-token: write'), `${name} must use npm Trusted Publishing`);
  requirePolicy(!credentialPattern.test(block), `${name} must not receive an npm credential`);
  requirePolicy(block.includes('npm@12.0.2'), `${name} must install the reviewed npm version`);
}

if (workflow.includes('SHIELDED_NPMJS_TOKEN')) {
  const recovery = job('token-recovery');
  const withoutRecovery = workflow.replace(recovery, '');

  requirePolicy(workflow.includes('workflow_dispatch:'), 'token recovery must be manually dispatched');
  requirePolicy(workflow.includes('publish-with-token'), 'token recovery must require explicit confirmation');
  requirePolicy(
    recovery.includes("github.event_name == 'workflow_dispatch'") &&
      recovery.includes("github.ref == 'refs/heads/main'") &&
      recovery.includes("inputs.confirm == 'publish-with-token'"),
    'token recovery must enforce the main-branch dispatch confirmation',
  );
  requirePolicy(
    recovery.includes('NPM_TOKEN: ${{ secrets.SHIELDED_NPMJS_TOKEN }}'),
    'token recovery must scope the npm token to its own job',
  );
  requirePolicy(!credentialPattern.test(withoutRecovery), 'npm credentials must only appear in token recovery');
  requirePolicy(recovery.includes('npm@12.0.2'), 'token recovery must install the reviewed npm version');
}

console.log('release workflow policy checks passed');

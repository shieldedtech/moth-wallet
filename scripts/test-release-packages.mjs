// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';

import * as releasePackages from './release-packages.mjs';
import {
  createReleasePlan,
  fetchGitHubReleaseTags,
  fetchPublishedVersions,
  findVersionIntroduction,
  loadPublicWorkspaces,
  npmPublishArguments,
  orderWorkspaces,
  packageDependencies,
  throwSpawnFailure,
} from './release-packages.mjs';

const rootDir = resolve(import.meta.dirname, '..');
const workspaces = loadPublicWorkspaces(rootDir);

assert.deepEqual(
  workspaces.map((workspace) => workspace.name).sort(),
  ['@shieldedtech/moth-cli', '@shieldedtech/moth-tui', '@shieldedtech/moth-wallet'],
  'release discovery must exclude private workspaces and nested template manifests',
);
assert.ok(
  workspaces.every((workspace) => workspace.access === 'public'),
  'every publishable workspace must explicitly declare public npm access',
);
assert.deepEqual(
  orderWorkspaces(workspaces).map((workspace) => workspace.name),
  ['@shieldedtech/moth-wallet', '@shieldedtech/moth-tui', '@shieldedtech/moth-cli'],
  'publish order must put internal dependencies first',
);

function publishedVersions(overrides = {}) {
  return new Map(
    workspaces.map((workspace) => [
      workspace.name,
      new Set(overrides[workspace.name] ?? [workspace.version]),
    ]),
  );
}

const releaseCommit = 'version-release-commit';
const versionCommits = new Map(workspaces.map((workspace) => [workspace.name, releaseCommit]));
const allTags = new Map(
  workspaces.map((workspace) => [
    `${workspace.name}@${workspace.version}`,
    versionCommits.get(workspace.name),
  ]),
);
const allReleases = new Set(allTags.keys());

function releaseState(overrides = {}) {
  return {
    tagTargets: allTags,
    publishedVersions: publishedVersions(),
    versionCommits,
    githubReleaseTags: allReleases,
    currentCommit: 'later-commit',
    ...overrides,
  };
}

assert.deepEqual(createReleasePlan(workspaces, releaseState()), {
  publish: [],
  tag: [],
  release: [],
  releaseWork: [],
});

const core = workspaces.find((workspace) => workspace.name === '@shieldedtech/moth-wallet');
const tui = workspaces.find((workspace) => workspace.name === '@shieldedtech/moth-tui');
const cli = workspaces.find((workspace) => workspace.name === '@shieldedtech/moth-cli');

const changesetsOutputDirectory = mkdtempSync(resolve(tmpdir(), 'moth-changesets-output-'));
const changesetsOutputPath = resolve(changesetsOutputDirectory, 'events.ndjson');
try {
  assert.equal(
    typeof releasePackages.writeChangesetsOutput,
    'function',
    'the custom publisher must expose Changesets action v2 output',
  );
  releasePackages.writeChangesetsOutput(
    [
      {name: '@shieldedtech/example-core', releaseTag: '@shieldedtech/example-core@1.2.3'},
      {name: '@shieldedtech/example-cli', releaseTag: '@shieldedtech/example-cli@1.2.3'},
    ],
    changesetsOutputPath,
  );
  assert.equal(
    readFileSync(changesetsOutputPath, 'utf8'),
    '{"type":"git-tag","tag":"@shieldedtech/example-core@1.2.3","packageName":"@shieldedtech/example-core"}\n' +
      '{"type":"git-tag","tag":"@shieldedtech/example-cli@1.2.3","packageName":"@shieldedtech/example-cli"}\n',
    'the custom publisher must emit the NDJSON contract consumed by Changesets action v2',
  );
} finally {
  rmSync(changesetsOutputDirectory, {recursive: true, force: true});
}

const unpublishedCorePlan = createReleasePlan(
  workspaces,
  releaseState({
    tagTargets: new Map([...allTags].filter(([tag]) => tag !== `${core.name}@${core.version}`)),
    publishedVersions: publishedVersions({[core.name]: ['0.12.0']}),
    githubReleaseTags: new Set([...allReleases].filter((tag) => tag !== `${core.name}@${core.version}`)),
    currentCommit: releaseCommit,
  }),
);
assert.deepEqual(unpublishedCorePlan.publish.map((workspace) => workspace.name), [core.name]);
assert.deepEqual(unpublishedCorePlan.tag, []);

const partialRetryPlan = createReleasePlan(
  workspaces,
  releaseState({
    tagTargets: new Map([[`${core.name}@${core.version}`, versionCommits.get(core.name)]]),
    publishedVersions: publishedVersions({
      [tui.name]: ['0.12.0'],
      [cli.name]: ['0.12.0'],
    }),
    githubReleaseTags: new Set([`${core.name}@${core.version}`]),
    currentCommit: releaseCommit,
  }),
);
assert.deepEqual(
  partialRetryPlan.publish.map((workspace) => workspace.name),
  [tui.name, cli.name],
  'a partial retry must skip the tagged package and finish in dependency order',
);

const missingTagPlan = createReleasePlan(
  workspaces,
  releaseState({tagTargets: new Map(), githubReleaseTags: new Set()}),
);
assert.deepEqual(
  missingTagPlan.tag.map((workspace) => workspace.name),
  [core.name, tui.name, cli.name],
  'published packages with missing Git tags must be recoverable without republishing',
);
assert.deepEqual(
  missingTagPlan.tag.map((workspace) => workspace.targetSha),
  workspaces.map((workspace) => versionCommits.get(workspace.name)),
  'recovered tags must target the commit that introduced the package version',
);

assert.throws(
  () =>
    createReleasePlan(
      workspaces,
      releaseState({
        tagTargets: new Map([[`${core.name}@${core.version}`, 'unrelated-later-commit']]),
      }),
    ),
  /does not match version commit/u,
  'an existing tag on the wrong commit must fail closed',
);

assert.throws(
  () =>
    createReleasePlan(
      workspaces,
      releaseState({
        tagTargets: new Map([[`${core.name}@${core.version}`, versionCommits.get(core.name)]]),
        publishedVersions: publishedVersions({[core.name]: ['0.12.0']}),
        githubReleaseTags: new Set(),
        currentCommit: releaseCommit,
      }),
    ),
  /tagged in Git but missing from npm/u,
  'a tag without a matching npm version must fail instead of silently skipping release work',
);

assert.throws(
  () =>
    createReleasePlan(
      workspaces,
      releaseState({
        tagTargets: new Map([...allTags].filter(([tag]) => tag !== `${core.name}@${core.version}`)),
        publishedVersions: publishedVersions({[core.name]: ['0.12.0']}),
        githubReleaseTags: new Set([...allReleases].filter((tag) => tag !== `${core.name}@${core.version}`)),
        currentCommit: 'unrelated-later-commit',
      }),
    ),
  /refusing to publish it from unrelated-later-commit/u,
  'an unpublished version must only be published by the commit that introduced it',
);

const missingReleasePlan = createReleasePlan(
  workspaces,
  releaseState({
    githubReleaseTags: new Set(
      [...allReleases].filter((tag) => tag !== `${core.name}@${core.version}`),
    ),
  }),
);
assert.deepEqual(
  missingReleasePlan.release.map((workspace) => workspace.name),
  [core.name],
  'a missing GitHub Release must be recovered even when npm and the Git tag already exist',
);
assert.throws(
  () =>
    createReleasePlan(
      workspaces,
      releaseState({
        tagTargets: new Map([...allTags].filter(([tag]) => tag !== `${core.name}@${core.version}`)),
      }),
    ),
  /GitHub Release exists but its Git tag is missing/u,
  'a release without its tag must fail closed instead of attempting a duplicate release',
);

assert.equal(
  findVersionIntroduction(core, [
    {
      sha: 'unrelated-later-commit',
      manifest: {name: core.name, version: core.version},
      parentManifest: {name: core.name, version: core.version},
    },
    {
      sha: 'actual-version-commit',
      manifest: {name: core.name, version: core.version},
      parentManifest: {name: core.name, version: '0.12.0'},
    },
  ]),
  'actual-version-commit',
  'later package metadata changes must not become the release tag target',
);
assert.deepEqual(
  npmPublishArguments(core),
  [
    'publish',
    '--workspace',
    core.workspace,
    '--access',
    'public',
    '--registry',
    'https://registry.npmjs.org/',
  ],
  'stable publication must explicitly preserve public package access',
);
assert.deepEqual(
  npmPublishArguments({...core, version: '0.13.0-rc.2'}),
  [
    'publish',
    '--workspace',
    core.workspace,
    '--access',
    'public',
    '--registry',
    'https://registry.npmjs.org/',
    '--tag',
    'rc',
  ],
  'prereleases must publish under their prerelease dist-tag instead of latest',
);
assert.deepEqual(
  npmPublishArguments(core, {dryRun: true}),
  [
    'publish',
    '--workspace',
    core.workspace,
    '--access',
    'public',
    '--registry',
    'https://registry.npmjs.org/',
    '--dry-run',
    '--ignore-scripts',
  ],
  'validation must exercise the same public registry contract without publishing',
);
assert.deepEqual(
  packageDependencies({
    dependencies: {runtime: '^1.0.0'},
    optionalDependencies: {optional: '^1.0.0'},
    peerDependencies: {peer: '^1.0.0'},
  }),
  {runtime: '^1.0.0', optional: '^1.0.0', peer: '^1.0.0'},
  'peer dependencies must participate in public-workspace publish ordering',
);
assert.throws(
  () =>
    throwSpawnFailure(
      {status: null, stderr: undefined, error: new Error('spawn git ENOENT')},
      'failed to create tag',
    ),
  /spawn git ENOENT/u,
  'spawn failures must preserve their real diagnostic when stderr is unavailable',
);

let requestedUrl;
const versions = await fetchPublishedVersions('@shieldedtech/moth-wallet', {
  registry: 'https://registry.example.test/',
  fetchImpl: async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({versions: {'0.12.0': {}, '0.12.1': {}}}),
    };
  },
});
assert.deepEqual([...versions], ['0.12.0', '0.12.1']);
assert.match(
  requestedUrl,
  /^https:\/\/registry\.example\.test\/%40shieldedtech%2Fmoth-wallet\?cache-bust=/u,
);

let registryAttempts = 0;
const retriedVersions = await fetchPublishedVersions('@shieldedtech/moth-wallet', {
  requiredVersion: '0.12.1',
  maxAttempts: 2,
  retryDelayMs: 0,
  sleepImpl: async () => {},
  fetchImpl: async (url, init) => {
    registryAttempts += 1;
    assert.match(String(url), /cache-bust=/u);
    assert.equal(init.headers['cache-control'], 'no-cache');
    return {
      ok: true,
      status: 200,
      json: async () => ({versions: registryAttempts === 1 ? {'0.12.0': {}} : {'0.12.1': {}}}),
    };
  },
});
assert.equal(registryAttempts, 2, 'a missing current version must be retried after registry lag');
assert.ok(retriedVersions.has('0.12.1'));

let releaseUrl;
assert.deepEqual(
  await fetchGitHubReleaseTags(['@shieldedtech/moth-wallet@0.12.1', '@shieldedtech/moth-tui@0.12.1'], {
    repository: 'shieldedtech/moth-wallet',
    fetchImpl: async (url) => {
      releaseUrl = String(url);
      const found = releaseUrl.endsWith(encodeURIComponent('@shieldedtech/moth-wallet@0.12.1'));
      return {ok: found, status: found ? 200 : 404};
    },
  }),
  new Set(['@shieldedtech/moth-wallet@0.12.1']),
);
assert.match(releaseUrl, /%40shieldedtech%2Fmoth-tui%400\.12\.1/u);
await assert.rejects(
  fetchGitHubReleaseTags(['@shieldedtech/moth-wallet@0.12.1'], {
    repository: 'shieldedtech/moth-wallet',
    fetchImpl: async () => ({ok: false, status: 503}),
  }),
  /failed with HTTP 503/u,
  'GitHub Release lookup failures must fail closed',
);

assert.deepEqual(
  await fetchPublishedVersions('@shieldedtech/new-package', {
    fetchImpl: async () => ({ok: false, status: 404}),
  }),
  new Set(),
);
await assert.rejects(
  fetchPublishedVersions('@shieldedtech/moth-wallet', {
    fetchImpl: async () => ({ok: false, status: 503}),
  }),
  /failed with HTTP 503/u,
  'registry failures must fail closed',
);

console.log('release package reconciliation checks passed');

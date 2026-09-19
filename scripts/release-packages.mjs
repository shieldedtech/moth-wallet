// SPDX-FileCopyrightText: Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import {execFileSync, spawnSync} from 'node:child_process';
import {appendFileSync, globSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, posix, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

function requireString(value, description) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

export function packageDependencies(packageJson) {
  return {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };
}

export function loadPublicWorkspaces(rootDir) {
  const rootPackage = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  const workspacePatterns = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;

  if (!Array.isArray(workspacePatterns)) {
    throw new Error('package.json must define workspaces as an array');
  }

  const manifestPaths = [
    ...new Set(
      workspacePatterns.flatMap((pattern) =>
        globSync(posix.join(requireString(pattern, 'workspace pattern'), 'package.json'), {
          cwd: rootDir,
        }),
      ),
    ),
  ].sort();

  return manifestPaths
    .map((manifestPath) => {
      const packageJson = JSON.parse(readFileSync(resolve(rootDir, manifestPath), 'utf8'));
      return {
        name: requireString(packageJson.name, `${manifestPath} name`),
        version: requireString(packageJson.version, `${manifestPath} version`),
        private: packageJson.private === true,
        access: packageJson.publishConfig?.access,
        workspace: dirname(manifestPath),
        dependencies: packageDependencies(packageJson),
      };
    })
    .filter((workspace) => !workspace.private)
    .map((workspace) => {
      if (workspace.access !== 'public') {
        throw new Error(`${workspace.name} must set publishConfig.access to public`);
      }
      return workspace;
    });
}

export function orderWorkspaces(workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(workspace) {
    if (visited.has(workspace.name)) return;
    if (visiting.has(workspace.name)) {
      throw new Error(`circular public workspace dependency involving ${workspace.name}`);
    }

    visiting.add(workspace.name);
    for (const dependencyName of Object.keys(workspace.dependencies).sort()) {
      const dependency = byName.get(dependencyName);
      if (dependency) visit(dependency);
    }
    visiting.delete(workspace.name);
    visited.add(workspace.name);
    ordered.push(workspace);
  }

  for (const workspace of [...workspaces].sort((left, right) => left.name.localeCompare(right.name))) {
    visit(workspace);
  }
  return ordered;
}

export function createReleasePlan(workspaces, state) {
  const {
    tagTargets,
    publishedVersions,
    versionCommits,
    githubReleaseTags,
    currentCommit,
  } = state;
  const publish = [];
  const tag = [];
  const release = [];

  for (const workspace of orderWorkspaces(workspaces)) {
    const releaseTag = `${workspace.name}@${workspace.version}`;
    const tagTarget = tagTargets.get(releaseTag);
    const isTagged = tagTarget !== undefined;
    const hasGitHubRelease = githubReleaseTags.has(releaseTag);
    const targetSha = requireString(
      versionCommits.get(workspace.name),
      `${releaseTag} version commit`,
    );
    const versions = publishedVersions.get(workspace.name);
    if (!(versions instanceof Set)) {
      throw new Error(`missing registry result for ${workspace.name}`);
    }

    const isPublished = versions.has(workspace.version);
    if (hasGitHubRelease && !isTagged) {
      throw new Error(`${releaseTag} GitHub Release exists but its Git tag is missing`);
    }
    if (isTagged && tagTarget !== targetSha) {
      throw new Error(`${releaseTag} tag target ${tagTarget} does not match version commit ${targetSha}`);
    }
    if (isTagged && !isPublished) {
      throw new Error(`${releaseTag} is tagged in Git but missing from npm`);
    }
    if (!isTagged && !isPublished) {
      if (currentCommit !== targetSha) {
        throw new Error(
          `${releaseTag} was introduced by ${targetSha}; refusing to publish it from ${currentCommit}`,
        );
      }
      publish.push({...workspace, releaseTag, targetSha});
    }
    if (!isTagged && isPublished) tag.push({...workspace, releaseTag, targetSha});
    if (isTagged && isPublished && !hasGitHubRelease) {
      release.push({...workspace, releaseTag, targetSha});
    }
  }

  return {publish, tag, release, releaseWork: [...publish, ...tag, ...release]};
}

export async function fetchPublishedVersions(packageName, options = {}) {
  const registry = options.registry ?? process.env.NPM_CONFIG_REGISTRY ?? DEFAULT_REGISTRY;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const sleepImpl = options.sleepImpl ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const packageUrl = new URL(
      encodeURIComponent(packageName),
      registry.endsWith('/') ? registry : `${registry}/`,
    );
    packageUrl.searchParams.set('cache-bust', `${Date.now()}-${attempt}`);
    const response = await fetchImpl(packageUrl, {
      headers: {
        accept: 'application/vnd.npm.install-v1+json',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
      },
    });

    let versions;
    if (response.status === 404) {
      versions = new Set();
    } else if (!response.ok) {
      if (response.status < 500 || attempt === maxAttempts - 1) {
        throw new Error(`npm registry lookup for ${packageName} failed with HTTP ${response.status}`);
      }
    } else {
      const metadata = await response.json();
      if (!metadata.versions || typeof metadata.versions !== 'object') {
        throw new Error(`npm registry response for ${packageName} has no versions map`);
      }
      versions = new Set(Object.keys(metadata.versions));
    }

    if (
      versions &&
      (!options.requiredVersion || versions.has(options.requiredVersion) || attempt === maxAttempts - 1)
    ) {
      return versions;
    }
    await sleepImpl(retryDelayMs * 2 ** attempt);
  }

  throw new Error(`npm registry lookup for ${packageName} exhausted its retry budget`);
}

export async function fetchGitHubReleaseTags(releaseTags, options = {}) {
  const repository = requireString(
    options.repository ?? process.env.GITHUB_REPOSITORY,
    'GitHub repository',
  );
  if (!/^[^/]+\/[^/]+$/u.test(repository)) {
    throw new Error('GitHub repository must use owner/name format');
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiUrl = options.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const token = options.token ?? process.env.GITHUB_TOKEN;
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? {authorization: `Bearer ${token}`} : {}),
  };

  const results = await Promise.all(
    releaseTags.map(async (releaseTag) => {
      const url = new URL(
        `/repos/${repository}/releases/tags/${encodeURIComponent(releaseTag)}`,
        apiUrl,
      );
      const response = await fetchImpl(url, {headers});
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`GitHub Release lookup for ${releaseTag} failed with HTTP ${response.status}`);
      }
      return releaseTag;
    }),
  );
  return new Set(results.filter(Boolean));
}

function existingTagTargets(rootDir) {
  const output = execFileSync('git', ['tag', '--list'], {cwd: rootDir, encoding: 'utf8'});
  return new Map(
    output
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((tag) => [
        tag,
        execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {
          cwd: rootDir,
          encoding: 'utf8',
        }).trim(),
      ]),
  );
}

function manifestAtRevision(rootDir, revision, manifestPath) {
  const result = spawnSync('git', ['show', `${revision}:${manifestPath}`], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) return undefined;
  return JSON.parse(result.stdout);
}

export function findVersionIntroduction(workspace, history) {
  for (const entry of history) {
    const manifestMatches =
      entry.manifest?.name === workspace.name && entry.manifest?.version === workspace.version;
    const parentMatches =
      entry.parentManifest?.name === workspace.name &&
      entry.parentManifest?.version === workspace.version;
    if (manifestMatches && !parentMatches) return requireString(entry.sha, 'version commit');
  }
  throw new Error(`could not find the commit that introduced ${workspace.name}@${workspace.version}`);
}

export function resolveVersionCommit(rootDir, workspace) {
  const manifestPath = posix.join(workspace.workspace, 'package.json');
  const commits = execFileSync(
    'git',
    ['log', '--first-parent', '--format=%H', '--', manifestPath],
    {cwd: rootDir, encoding: 'utf8'},
  )
    .split(/\r?\n/u)
    .filter(Boolean);

  const history = commits.map((sha) => {
    const revision = execFileSync('git', ['rev-list', '--parents', '-n', '1', sha], {
      cwd: rootDir,
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/u);
    return {
      sha,
      manifest: manifestAtRevision(rootDir, sha, manifestPath),
      parentManifest: revision[1]
        ? manifestAtRevision(rootDir, revision[1], manifestPath)
        : undefined,
    };
  });

  return findVersionIntroduction(workspace, history);
}

export function throwSpawnFailure(result, description) {
  if (result.status === 0) return;
  const detail = result.error?.message ?? result.stderr?.trim() ?? `exit status ${result.status}`;
  throw new Error(`${description}: ${detail}`, result.error ? {cause: result.error} : undefined);
}

function configuredRegistry(rootDir, registryOverride) {
  if (registryOverride) return new URL(registryOverride).href;
  if (process.env.NPM_CONFIG_REGISTRY) return new URL(process.env.NPM_CONFIG_REGISTRY).href;

  const result = spawnSync('npm', ['config', 'get', 'registry'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  throwSpawnFailure(result, 'failed to resolve the npm registry');
  return new URL(requireString(result.stdout.trim(), 'npm registry')).href;
}

export async function calculateReleasePlan(rootDir, options = {}) {
  const workspaces = loadPublicWorkspaces(rootDir);
  const tagTargets = options.existingTags ?? existingTagTargets(rootDir);
  const versionCommits = new Map(
    workspaces.map((workspace) => [
      workspace.name,
      options.versionCommits?.get(workspace.name) ?? resolveVersionCommit(rootDir, workspace),
    ]),
  );
  const registry = configuredRegistry(rootDir, options.registry);
  const releaseTags = workspaces.map((workspace) => `${workspace.name}@${workspace.version}`);
  const [publishedEntries, githubReleaseTags] = await Promise.all([
    Promise.all(
      workspaces.map(async (workspace) => [
        workspace.name,
        await fetchPublishedVersions(workspace.name, {
          fetchImpl: options.fetchImpl,
          registry,
          requiredVersion: workspace.version,
          maxAttempts: options.registryAttempts ?? 4,
          retryDelayMs: options.retryDelayMs,
          sleepImpl: options.sleepImpl,
        }),
      ]),
    ),
    options.existingReleases
      ? Promise.resolve(options.existingReleases)
      : fetchGitHubReleaseTags(releaseTags, {
          fetchImpl: options.githubFetchImpl,
          repository: options.repository,
          token: options.githubToken,
          apiUrl: options.githubApiUrl,
        }),
  ]);
  const publishedVersions = new Map(publishedEntries);

  const currentCommit =
    options.currentCommit ??
    execFileSync('git', ['rev-parse', 'HEAD'], {cwd: rootDir, encoding: 'utf8'}).trim();
  return {
    ...createReleasePlan(workspaces, {
      tagTargets,
      publishedVersions,
      versionCommits,
      githubReleaseTags,
      currentCommit,
    }),
    registry,
  };
}

function appendGitHubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required in plan mode');
  appendFileSync(outputPath, `${name}=${value}\n`);
}

export function writeChangesetsOutput(releaseWork, outputPath = process.env.CHANGESETS_OUTPUT) {
  if (!outputPath) return;
  appendFileSync(
    outputPath,
    releaseWork
      .map((workspace) =>
        JSON.stringify({
          type: 'git-tag',
          tag: requireString(workspace.releaseTag, 'release tag'),
          packageName: requireString(workspace.name, 'package name'),
        }),
      )
      .join('\n') + (releaseWork.length > 0 ? '\n' : ''),
  );
}

function createTag(rootDir, releaseTag, targetSha) {
  const result = spawnSync('git', ['tag', '-a', releaseTag, targetSha, '-m', releaseTag], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  throwSpawnFailure(result, `failed to create ${releaseTag}`);
  console.log(`New tag: ${releaseTag}`);
}

function prereleaseDistTag(version) {
  const prerelease = version.match(/^\d+\.\d+\.\d+-([0-9A-Za-z-]+)(?:[.-].*)?$/u);
  return prerelease?.[1];
}

export function npmPublishArguments(workspace, options = {}) {
  if (workspace.access !== 'public') {
    throw new Error(`${workspace.name} must publish with public npm access`);
  }
  const registry = new URL(options.registry ?? DEFAULT_REGISTRY).href;
  const arguments_ = [
    'publish',
    '--workspace',
    workspace.workspace,
    '--access',
    'public',
    '--registry',
    registry,
  ];
  const distTag = prereleaseDistTag(workspace.version);
  if (distTag) arguments_.push('--tag', distTag);
  if (options.dryRun) arguments_.push('--dry-run', '--ignore-scripts');
  return arguments_;
}

function publishWorkspace(rootDir, workspace, registry, options = {}) {
  console.log(
    `${options.dryRun ? 'Validating' : 'Publishing'} ${workspace.name}@${workspace.version}`,
  );
  const result = spawnSync('npm', npmPublishArguments(workspace, {registry, ...options}), {
    cwd: rootDir,
    stdio: 'inherit',
  });
  throwSpawnFailure(
    result,
    `npm publish${options.dryRun ? ' dry-run' : ''} failed for ${workspace.name}@${workspace.version}`,
  );
}

async function main() {
  const rootDir = process.cwd();
  const plan = await calculateReleasePlan(rootDir);

  if (process.argv.includes('--github-output')) {
    appendGitHubOutput('hasReleaseWork', String(plan.releaseWork.length > 0));
    appendGitHubOutput('hasUnpublished', String(plan.publish.length > 0));
    if (process.argv.includes('--validate')) {
      for (const workspace of plan.publish) {
        publishWorkspace(rootDir, workspace, plan.registry, {dryRun: true});
      }
    }
    console.log(`Release work: ${plan.releaseWork.map((item) => item.releaseTag).join(', ') || 'none'}`);
    return;
  }

  for (const workspace of plan.publish) {
    publishWorkspace(rootDir, workspace, plan.registry);
    createTag(rootDir, workspace.releaseTag, workspace.targetSha);
  }
  for (const workspace of plan.tag) {
    console.log(`${workspace.releaseTag} already exists on npm; recovering its Git tag`);
    createTag(rootDir, workspace.releaseTag, workspace.targetSha);
  }
  for (const workspace of plan.release) {
    console.log(`${workspace.releaseTag} is missing its GitHub Release; recovering it`);
    console.log(`New tag: ${workspace.releaseTag}`);
  }
  writeChangesetsOutput(plan.releaseWork);
  if (plan.releaseWork.length === 0) console.log('No release work found');
}

const entrypoint = process.argv[1] ? realpathSync(resolve(process.argv[1])) : undefined;
if (entrypoint === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}

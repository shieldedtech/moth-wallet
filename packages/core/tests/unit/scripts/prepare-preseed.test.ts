import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const helperPath = '../../../../../scripts/lib/prepare-preseed.mjs';
const workflowPath = fileURLToPath(
  new URL('../../../../../.github/workflows/prepare-preseed.yml', import.meta.url),
);
const cdWorkflowPath = fileURLToPath(
  new URL('../../../../../.github/workflows/cd.yml', import.meta.url),
);

async function loadHelper(): Promise<Record<string, unknown>> {
  return import(helperPath).catch(() => ({}));
}

describe('preparePreseed', () => {
  it('exposes an incremental preparation function', async () => {
    const helper = await loadHelper();

    expect(helper.preparePreseed).toBeTypeOf('function');
  });

  it('refreshes an existing reference and reports the height delta', async () => {
    const {preparePreseed} = (await loadHelper()) as {
      preparePreseed: (
        networkId: string,
        dependencies: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const network = {id: 'preprod'};
    const calls: string[] = [];
    const progress: string[] = [];

    const result = await preparePreseed('preprod', {
      networks: {preprod: network},
      status: async () => {
        calls.push('status');
        return {ready: true, height: 100};
      },
      refresh: async (_network: unknown, onProgress: (message: string) => void) => {
        calls.push('refresh');
        onProgress('catching up');
        return {height: 125};
      },
      onProgress: (message: string) => progress.push(message),
      now: () => 8_000,
      startedAt: 5_000,
    });

    expect(calls).toEqual(['status', 'refresh']);
    expect(progress).toEqual(['catching up']);
    expect(result).toEqual({
      network: 'preprod',
      previousHeight: 100,
      height: 125,
      advancedBy: 25,
      elapsedSeconds: 3,
    });
  });

  it('rejects an unknown network before attempting a refresh', async () => {
    const {preparePreseed} = (await loadHelper()) as {
      preparePreseed: (networkId: string, dependencies: Record<string, unknown>) => Promise<unknown>;
    };

    await expect(
      preparePreseed('mainnet', {
        networks: {preview: {id: 'preview'}, preprod: {id: 'preprod'}},
        status: async () => {
          throw new Error('status must not run');
        },
        refresh: async () => {
          throw new Error('refresh must not run');
        },
      }),
    ).rejects.toThrow('Unknown network "mainnet". Expected preview or preprod.');
  });

  it('fails when the reference does not reach chain tip', async () => {
    const {preparePreseed} = (await loadHelper()) as {
      preparePreseed: (networkId: string, dependencies: Record<string, unknown>) => Promise<unknown>;
    };

    await expect(
      preparePreseed('preview', {
        networks: {preview: {id: 'preview'}},
        status: async () => ({ready: false, height: null}),
        refresh: async () => null,
      }),
    ).rejects.toThrow('Preseed reference for preview did not reach chain tip.');
  });
});

describe('prepare-preseed workflow', () => {
  it('is committed as a GitHub Actions workflow', () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  it('is read-only and cannot publish or mutate the repository', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toMatch(/permissions:\n  contents: read/);
    expect(workflow).not.toMatch(/id-token: write|npm publish|git push|gh pr|aws /);
    expect(workflow).not.toContain('secrets[matrix.secret_name]');
    expect(workflow).toContain('secrets.PRESEED_MNEMONIC_PREVIEW');
    expect(workflow).toContain('secrets.PRESEED_MNEMONIC_PREPROD');
  });

  it('can only be started by an explicit manual dispatch', () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    expect(workflow).not.toContain('\n  push:');
  });

  it('caches only public reference state', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const cachePaths = [...workflow.matchAll(/uses: actions\/cache\/(?:restore|save)@[^\n]+\n\s+with:\n\s+path: \|\n((?:\s{12}.+\n)+)/g)]
      .map((match) => match[1])
      .join('\n');

    expect(cachePaths).toContain('__empty_ref__');
    expect(cachePaths).toContain('height.txt');
    expect(cachePaths).not.toContain('mnemonic.txt');
  });
});

describe('extension release workflow', () => {
  it('fails the release when the zip is missing either network preseed assets', () => {
    const workflow = readFileSync(cdWorkflowPath, 'utf8');

    expect(workflow).toContain("branches:\n      - main");
    expect(workflow).toContain('echo "tag=moth-extension-v${version}"');
    expect(workflow).toContain('git push origin "$TAG"');
    expect(workflow).toContain('Release $TAG already exists; leaving its published asset unchanged.');
    expect(workflow).toContain('for network in preview preprod; do');
    expect(workflow).toContain('unzip -tq "$ARTIFACT" "preseed/${network}/${part}"');
    expect(workflow).toContain('unzip -p "$ARTIFACT" "preseed/${network}/manifest.json"');
    expect(workflow).toContain('manifest.network !== network');
  });
});

describe('pre-seed collapse in the workflows', () => {
  const read = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../../../../../.github/workflows/${name}`, import.meta.url)), 'utf8');
  const step = (workflow: string, name: string) => {
    const start = workflow.indexOf(`- name: ${name}`);
    const next = workflow.indexOf('- name:', start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  };

  it('collapses, verifies and end-to-end tests a prepared bundle before uploading it', () => {
    const workflow = read('prepare-preseed.yml');
    const order = [
      'node scripts/prepare-preseed.mjs',
      'node scripts/export-preseed.mjs',
      'node scripts/collapse-preseed.mjs --dir "$EXPORT_DIR" --check',
      'yarn turbo run test',
      'yarn workspace @shieldedtech/moth-cli test:e2e',
      'actions/upload-artifact',
    ].map((marker) => workflow.indexOf(marker));

    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(workflow).toContain('MOTH_E2E_NETWORK: ${{ matrix.network }}');
  });

  it('keeps the end-to-end test away from the reference mnemonic', () => {
    const e2e = step(read('prepare-preseed.yml'), 'End-to-end test the exported bundle with the CLI');
    expect(e2e).not.toBe('');
    expect(e2e).not.toContain('secrets.');
  });

  it('runs the preprod end-to-end test on every pull request, without blocking merges', () => {
    const ci = read('ci.yml');
    expect(ci).toMatch(/on:\n  pull_request:\n/);

    const job = ci.slice(ci.indexOf('\n  e2e-preprod:'), ci.indexOf('\n  coverage:'));
    expect(job).toContain('continue-on-error: true');
    expect(job).toContain('MOTH_E2E_NETWORK: preprod');
    expect(job).toContain('yarn workspace @shieldedtech/moth-cli test:e2e');
    // No secrets, so it runs on pull requests from forks as well; no condition, so
    // it runs on all of them.
    expect(job).not.toContain('secrets.');
    expect(job).not.toMatch(/\n    if:/);
  });

  it('checks the committed bundles are collapsed on every PR and before packaging a release', () => {
    expect(step(read('ci.yml'), 'Check committed preseed bundles are collapsed and valid')).toContain(
      'node scripts/collapse-preseed.mjs --check',
    );

    const cd = read('cd.yml');
    const check = cd.indexOf('node scripts/collapse-preseed.mjs --check');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(cd.indexOf('yarn workspace @shieldedtech/moth-extension zip'));
  });
});

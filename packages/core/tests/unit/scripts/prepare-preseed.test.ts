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
    ).rejects.toThrow('Unknown network "mainnet". Expected one of: preview, preprod.');
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

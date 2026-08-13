import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadContractArtifact, type ContractArtifact } from '../../../src/contract/artifact-loader.js';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Contract Artifact Loader', () => {
  const testDir = join(tmpdir(), `artifact-test-${Date.now()}`);
  const validDir = join(testDir, 'valid-contract');
  const emptyDir = join(testDir, 'empty-contract');

  beforeAll(async () => {
    await mkdir(validDir, { recursive: true });
    await mkdir(emptyDir, { recursive: true });

    // Create a minimal valid artifact structure
    await writeFile(
      join(validDir, 'contract.cjs'),
      'module.exports = { circuits: { increment: {}, decrement: {} }, initialState: "00" };',
    );
    // managed/keys directory is optional — not needed for artifact loading
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should load a valid artifact directory', async () => {
    const artifact = await loadContractArtifact(validDir);
    expect(artifact).toBeDefined();
    expect(artifact.path).toBe(validDir);
    expect(artifact.circuits).toContain('increment');
    expect(artifact.circuits).toContain('decrement');
  });

  it('should reject a non-existent directory', async () => {
    await expect(
      loadContractArtifact('/nonexistent/path'),
    ).rejects.toThrow();
  });

  it('should reject a directory without contract files', async () => {
    await expect(
      loadContractArtifact(emptyDir),
    ).rejects.toThrow();
  });
});

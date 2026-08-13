import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInputError } from '../types/errors.js';

export interface ContractArtifact {
  /** The managed/ directory path (the root passed by the user) */
  readonly path: string;
  /** Path to the contract/ subdirectory containing index.js */
  readonly contractDir: string;
  readonly circuits: string[];
  readonly contractModule: Record<string, unknown>;
}

/**
 * Load a compiled Compact contract from a managed/ directory.
 *
 * Accepts the path output by `compact compile`:
 *   managed/
 *   ├── contract/     ← contains index.js (the contract module)
 *   │   ├── index.js
 *   │   ├── index.d.ts
 *   │   └── index.js.map
 *   ├── keys/         ← prover/verifier keys
 *   ├── zkir/         ← zero-knowledge IR
 *   └── compiler/
 *
 * Also accepts the contract/ subdirectory directly, or a directory
 * containing .js files at the root (legacy/simple layout).
 */
export async function loadContractArtifact(rawPath: string): Promise<ContractArtifact> {
  const artifactPath = rawPath.trim();
  // Verify directory exists
  try {
    const s = await stat(artifactPath);
    if (!s.isDirectory()) {
      throw new InvalidInputError(`Not a directory: ${artifactPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InvalidInputError(`Artifact directory not found: ${artifactPath}`);
    }
    throw err;
  }

  // Strategy 1: managed/ directory with contract/ subdirectory
  const contractSubdir = join(artifactPath, 'contract');
  try {
    const contractStat = await stat(contractSubdir);
    if (contractStat.isDirectory()) {
      return await loadFromContractDir(artifactPath, contractSubdir);
    }
  } catch { /* no contract/ subdir — try other strategies */ }

  // Strategy 2: The user passed the contract/ directory directly
  const entries = await readdir(artifactPath);
  if (entries.includes('index.js') || entries.includes('index.cjs') || entries.includes('index.mjs')) {
    // User pointed directly at the contract/ directory — parent is the managed/ dir
    const parentDir = join(artifactPath, '..');
    return await loadFromContractDir(parentDir, artifactPath);
  }

  // Strategy 3: Legacy — .js file at root
  const jsFile = entries.find(
    (e: string) => e.endsWith('.cjs') || e.endsWith('.mjs') || e.endsWith('.js'),
  );
  if (jsFile) {
    return await loadModuleAt(artifactPath, join(artifactPath, jsFile));
  }

  throw new InvalidInputError(
    `No contract module found in ${artifactPath}. ` +
    `Expected a managed/ directory from compact compile output ` +
    `(with contract/index.js inside), or a directory with a .js file.`,
  );
}

async function loadFromContractDir(managedDir: string, contractDir: string): Promise<ContractArtifact> {
  const entries = await readdir(contractDir);
  const indexFile = entries.find(
    (e: string) => e === 'index.js' || e === 'index.cjs' || e === 'index.mjs',
  );

  if (!indexFile) {
    throw new InvalidInputError(
      `No index.js found in ${contractDir}. Expected compact compile output.`,
    );
  }

  const artifact = await loadModuleAt(managedDir, join(contractDir, indexFile));
  return { ...artifact, contractDir };
}

async function loadModuleAt(basePath: string, modulePath: string): Promise<ContractArtifact> {
  let contractModule: Record<string, unknown>;

  try {
    const moduleUrl = new URL(`file://${modulePath}`);
    contractModule = await import(moduleUrl.href) as Record<string, unknown>;
  } catch (err) {
    throw new InvalidInputError(
      `Failed to load contract module at ${modulePath}: ${err}`,
    );
  }

  const circuits = await extractCircuitNames(basePath, contractModule);

  return {
    path: basePath,
    contractDir: join(modulePath, '..'),
    circuits,
    contractModule,
  };
}

interface CompactContractInfo {
  circuits?: Array<{ name?: string }>;
}

/**
 * Resolve the contract's circuit names. Preference order:
 *
 * 1. `<artifact>/compiler/contract-info.json` — the authoritative
 *    list emitted by the Compact compiler. Modern artifacts (>= 0.31)
 *    ship this, with each entry's `name` field carrying the
 *    user-facing circuit name. Use this whenever it exists.
 * 2. A `circuits` map on the contract module (legacy / hand-rolled
 *    artifacts).
 * 3. A `circuits` map on `module.default` (CJS shim).
 * 4. Module-level named exports as a last resort. This branch is
 *    fragile because modern Compact contracts export `Contract`,
 *    `ledger`, `pureCircuits`, `contractReferenceLocations` —
 *    none of which are real circuit names — but it remains for
 *    artifacts that predate `contract-info.json`.
 */
async function extractCircuitNames(
  basePath: string,
  module: Record<string, unknown>,
): Promise<string[]> {
  try {
    const infoPath = join(basePath, 'compiler', 'contract-info.json');
    const raw = await readFile(infoPath, 'utf-8');
    const info = JSON.parse(raw) as CompactContractInfo;
    if (Array.isArray(info.circuits)) {
      const names = info.circuits
        .map((c) => c?.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
      if (names.length > 0) return names;
    }
  } catch {
    /* fall through to module-introspection fallbacks */
  }

  if (module.circuits && typeof module.circuits === 'object') {
    return Object.keys(module.circuits);
  }
  if (module.default && typeof module.default === 'object') {
    const def = module.default as Record<string, unknown>;
    if (def.circuits && typeof def.circuits === 'object') {
      return Object.keys(def.circuits);
    }
  }
  return Object.keys(module).filter(
    key => key !== 'default' && key !== '__esModule',
  );
}

// Loading a dapp's contract SDK from the dapp's own dependency tree.
//
// A compiled Compact artifact is bound to the compact-runtime it was generated
// against — the generated module opens with `checkRuntimeVersion(...)`, which
// rejects any other minor — and that runtime, its compact-js and its
// midnight-js have to be one set of instances: the WASM objects they hand each
// other carry pointers into per-instantiation linear memories, so a class from
// one instantiation fails `instanceof` against the same class from another.
//
// The only tree that holds the set an artifact needs is the project's own, and
// it is the tree the artifact itself resolves `@midnight-ntwrk/compact-runtime`
// from (Node walks up from the artifact's path and never reaches moth's tree).
// So resolve the whole contract stack there, per slot, and fall back to moth's
// own copies for the slots a project doesn't ship.

import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve as resolvePath} from 'node:path';
import {pathToFileURL} from 'node:url';

/**
 * The project's contract stack. Every slot is optional: a project that ships
 * no SDK of its own yields an all-`undefined` stack, and each caller falls back
 * to moth's own copy for that slot.
 */
export interface ProjectStack {
  /** The directory whose `node_modules` the stack was resolved from. */
  readonly root: string;
  /** compact-js — the contract executable and its `CompiledContract` builder. */
  readonly compactJs?: any;
  /** midnight-js `contracts`: `deployContract`, `findDeployedContract`. */
  readonly contracts?: any;
  /** midnight-js `network-id`: the SDK's per-tree network-id global. */
  readonly networkId?: any;
  /** The ledger this generation builds transactions with, for `bridgeTx`. */
  readonly ledger?: any;
  readonly nodeZkConfigProvider?: any;
  readonly indexerPublicDataProvider?: any;
  readonly levelPrivateStateProvider?: any;
  readonly httpClientProofProvider?: any;
}

/** Walk an `exports` entry's condition object for the entry published to `import`. */
function pickEsmEntry(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return undefined;
  for (const condition of ['import', 'module', 'node', 'default']) {
    const hit = pickEsmEntry((node as Record<string, unknown>)[condition]);
    if (hit) return hit;
  }
  return undefined;
}

/** Split `@scope/pkg/sub` into its package name and its `exports` subpath key. */
function splitSpecifier(specifier: string): [name: string, subpath: string] {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const rest = specifier.slice(name.length);
  return [name, rest ? `.${rest}` : '.'];
}

/** Locate a package's manifest in `root`'s tree, walking up as Node would. */
function findManifest(req: NodeRequire, root: string, name: string): string | undefined {
  try {
    return req.resolve(`${name}/package.json`);
  } catch {
    // Not every package exports './package.json'. Walk the node_modules chain.
    let dir = resolvePath(root);
    for (;;) {
      const candidate = join(dir, 'node_modules', name, 'package.json');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

/**
 * Import `specifier` from `root`'s dependency tree as ESM.
 *
 * `createRequire(root).resolve()` finds the package but reports the entry it
 * publishes for `require`, and this SDK generation's platform-js is ESM-only —
 * so following the CJS entry names files that were never built. Read the
 * package's own `exports` map and import what it publishes for `import`.
 */
function makeImporter(root: string): (specifier: string) => Promise<any> {
  const req = createRequire(resolvePath(root, 'node_modules', '_moth_resolve.cjs'));
  return async (specifier: string) => {
    const [name, subpath] = splitSpecifier(specifier);
    const manifestPath = findManifest(req, root, name);
    if (!manifestPath) throw new Error(`${name} is not installed under ${root}`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    const entry =
      pickEsmEntry(manifest.exports?.[subpath]) ?? (subpath === '.' ? (manifest.module ?? manifest.main) : undefined);
    if (!entry) throw new Error(`${specifier} publishes no importable entry (${manifestPath})`);
    return import(pathToFileURL(join(dirname(manifestPath), entry)).href);
  };
}

/**
 * Resolve as much of the contract stack as `root` ships. Missing slots come
 * back `undefined` rather than throwing: a project that ships nothing is the
 * ordinary case for a dapp that keeps only its compiled artifact in-tree.
 */
export async function loadProjectStack(root: string): Promise<ProjectStack> {
  const importFromProject = makeImporter(root);
  const slot = async (specifier: string): Promise<any> => {
    try {
      return await importFromProject(specifier);
    } catch {
      return undefined;
    }
  };

  const [compactJs, contracts, networkId, ledger, zk, indexer, level, proof] = await Promise.all([
    slot('@midnight-ntwrk/compact-js'),
    slot('@midnight-ntwrk/midnight-js/contracts'),
    slot('@midnight-ntwrk/midnight-js/network-id'),
    // Every generation of midnight-js-protocol re-exports its own ledger under
    // the same subpath, so this asks "which ledger does this project build
    // transactions with" without naming v8 or v9.
    slot('@midnight-ntwrk/midnight-js-protocol/ledger'),
    slot('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
    slot('@midnight-ntwrk/midnight-js-indexer-public-data-provider'),
    slot('@midnight-ntwrk/midnight-js-level-private-state-provider'),
    slot('@midnight-ntwrk/midnight-js-http-client-proof-provider'),
  ]);

  return {
    root,
    compactJs,
    contracts,
    networkId,
    ledger,
    nodeZkConfigProvider: zk?.NodeZkConfigProvider,
    indexerPublicDataProvider: indexer?.indexerPublicDataProvider,
    levelPrivateStateProvider: level?.levelPrivateStateProvider,
    httpClientProofProvider: proof?.httpClientProofProvider,
  };
}

/**
 * Move a transaction between the project's ledger and moth's.
 *
 * The project builds and proves the transaction with its own ledger instance;
 * the wallet facade balances, signs and submits with moth's. Same package, same
 * version even, but two instantiations, so the objects have to travel as bytes.
 * Returns `tx` untouched when both sides are already the same instance.
 */
export function bridgeTx(tx: any, into: any, binding: 'binding' | 'pre-binding'): any {
  if (!tx || !into?.Transaction || tx instanceof into.Transaction) return tx;
  return into.Transaction.deserialize('signature', 'proof', binding, tx.serialize());
}

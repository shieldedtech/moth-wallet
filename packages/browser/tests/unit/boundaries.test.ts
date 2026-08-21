// Bundle-boundary guards for the browser library.
//
// `@shieldedtech/moth-browser` is what downstream DApps bundle. If anything in
// its transitive import graph reaches a Node builtin, every one of those bundles
// breaks — so the barrel deliberately re-exports from core *subpaths* rather than
// core's own barrel. That discipline is load-bearing and was previously enforced
// only by a comment: core's barrel pulls in the daemon, filesystem storage and
// contract tooling, so importing it here would drag dozens of platform specifiers
// into the browser graph in a single line. Measured while writing this: the walked
// graph from the browser entrypoint reaches none statically, core's barrel reaches
// 36.
//
// "The walked graph" is the load-bearing qualifier. wallet-sync hides two modules
// from static analysis behind a variable specifier, one of which does statically
// import three Node builtins — that indirection is deliberate and is what keeps a
// bundler from pulling it in, but it also ends the walk. Those stopping points are
// pinned rather than ignored, because an edge the walk cannot see would otherwise
// be indistinguishable from an edge that is not there.
//
// Two properties are asserted separately because they fail differently:
//
//   * A **static** platform import is evaluated the moment the module loads, so
//     it breaks a browser bundle unconditionally. Zero are tolerated.
//   * A **dynamic** one inside a function body only resolves if that function
//     runs, and the ones in the graph today are marked with a bundler-ignore
//     pragma so bundlers leave them alone. Those are pinned to an explicit list
//     rather than banned outright — a new one should be a deliberate decision,
//     not something discovered from a DApp bug report.
//
// The walk follows first-party specifiers only (this package and core). Third-party
// packages are not traversed, so a green run says nothing about what the wallet
// SDK or ledger drag in. The property protected here is that *our* code stays
// browser-safe.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allSpecifiers,
  isPlatformBuiltin,
  moduleImports,
  opaqueDynamicImports,
  runtimeSpecifiers,
} from '../../../core/tests/helpers/module-imports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '../../..');
const BROWSER_SRC = resolve(PACKAGES, 'browser/src');
const BROWSER_ENTRY = resolve(PACKAGES, 'browser/dist/index.js');
const CORE_DIST = resolve(PACKAGES, 'core/dist');
const CORE_PKG = '@shieldedtech/moth-wallet';

/**
 * Dynamic platform imports that already exist in the browser graph, as
 * `<file>: <specifier>`. Each is lazily evaluated and bundler-ignored, so it does
 * not break a bundle unless the surrounding code path actually runs in a browser.
 * Adding an entry here is a decision to accept that risk.
 */
const ALLOWED_DYNAMIC_PLATFORM_IMPORTS = new Set([
  // Node-only cleanup of on-disk sync artifacts. Never called in a browser,
  // which uses the IndexedDB sync store instead. Making the cleanup injectable
  // would remove these three and let this list go away.
  'core/dist/sync/wallet-sync.js: node:fs',
  'core/dist/sync/wallet-sync.js: node:path',
  'core/dist/sync/wallet-sync.js: node:os',
]);

/**
 * `import(...)` calls in the graph whose specifier is not a literal, as
 * `<file>: <argument>` in source order. A static walk cannot follow these, so
 * whatever is on the far side is outside everything asserted below — pinning them
 * is what stops that blind spot growing silently.
 *
 * Both entries are wallet-sync deliberately hiding a module from bundler analysis:
 * `./node-sync-store.js`, which statically imports three Node builtins, and `ws`.
 * The indirection is why a browser bundle survives them — a bundler cannot resolve
 * a variable specifier either — but it is also why the walk stops there.
 */
const ALLOWED_OPAQUE_DYNAMIC_IMPORTS = [
  'core/dist/sync/wallet-sync.js: specifier',
  'core/dist/sync/wallet-sync.js: specifier',
];

function tsSources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map(name => resolve(dir, name));
}

/** Resolve a specifier to a first-party file, or null if it leaves our code. */
function resolveFirstParty(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier);
  if (specifier === CORE_PKG) return resolve(CORE_DIST, 'index.js');
  // core's package.json maps "./*" to "./dist/*.js".
  if (specifier.startsWith(`${CORE_PKG}/`)) {
    return resolve(CORE_DIST, `${specifier.slice(CORE_PKG.length + 1)}.js`);
  }
  return null;
}

interface Opaque {
  file: string;
  argument: string;
}

interface PlatformReach {
  kind: 'static' | 'dynamic';
  specifier: string;
  file: string;
  chain: string;
}

function walkGraph(entry: string): {
  visited: string[];
  reached: PlatformReach[];
  unresolved: string[];
  opaque: Opaque[];
} {
  const visited = new Set<string>();
  const reached: PlatformReach[] = [];
  const unresolved: string[] = [];
  const opaque: Opaque[] = [];

  const visit = (file: string, chain: string[]): void => {
    if (visited.has(file)) return;
    visited.add(file);
    if (!existsSync(file)) {
      unresolved.push(relative(PACKAGES, file));
      return;
    }
    const trail = [...chain, file];
    const source = readFileSync(file, 'utf-8');
    for (const argument of opaqueDynamicImports(source)) {
      opaque.push({ file: relative(PACKAGES, file), argument });
    }
    for (const entryImport of moduleImports(source)) {
      const { specifier, kind } = entryImport;
      if (isPlatformBuiltin(specifier)) {
        reached.push({
          kind,
          specifier,
          file: relative(PACKAGES, file),
          chain: trail.map(f => relative(PACKAGES, f)).join(' -> '),
        });
        continue;
      }
      const next = resolveFirstParty(specifier, file);
      if (next) visit(next, trail);
    }
  };

  visit(entry, []);
  return { visited: [...visited], reached, unresolved, opaque };
}

describe('browser bundle boundary', () => {
  // Asserted rather than skipped on purpose: a guard that quietly passes when
  // there is nothing to inspect is the same do-nothing gate this repo deleted its
  // no-op `lint` script for.
  it('has a built entrypoint to inspect', () => {
    expect(
      existsSync(BROWSER_ENTRY),
      `${relative(PACKAGES, BROWSER_ENTRY)} is missing — run \`yarn build\` before this suite`,
    ).toBe(true);
  });

  it('resolves every first-party import in the graph', () => {
    const { unresolved, visited } = walkGraph(BROWSER_ENTRY);
    // An unresolved first-party file means the walk stopped early, so the
    // assertions below inspected less than they claim to.
    expect(unresolved).toEqual([]);
    expect(visited.length).toBeGreaterThan(10);
  });

  it('follows every import in the graph, or names the ones it cannot', () => {
    const found = walkGraph(BROWSER_ENTRY).opaque.map(entry => `${entry.file}: ${entry.argument}`);
    expect(
      found,
      'an import(...) with a non-literal specifier cannot be followed, so whatever it reaches is not covered by the assertions below. Give it a literal specifier, or add it to ALLOWED_OPAQUE_DYNAMIC_IMPORTS with a note on what is behind it',
    ).toEqual(ALLOWED_OPAQUE_DYNAMIC_IMPORTS);
  });

  it('never statically imports a platform builtin', () => {
    const offenders = walkGraph(BROWSER_ENTRY)
      .reached.filter(hit => hit.kind === 'static')
      .map(hit => `${hit.specifier} via ${hit.chain}`);
    expect(
      offenders,
      'a static node: import breaks every downstream DApp bundle at load time',
    ).toEqual([]);
  });

  it('reaches no dynamic platform builtin beyond the accepted list', () => {
    const found = new Set(
      walkGraph(BROWSER_ENTRY)
        .reached.filter(hit => hit.kind === 'dynamic')
        .map(hit => `${hit.file}: ${hit.specifier}`),
    );

    const added = [...found].filter(entry => !ALLOWED_DYNAMIC_PLATFORM_IMPORTS.has(entry)).sort();
    expect(
      added,
      'new dynamic node: import in the browser graph — make it injectable, or add it to ALLOWED_DYNAMIC_PLATFORM_IMPORTS with a note on why it is safe',
    ).toEqual([]);

    // Stale entries matter too: an accepted exception that no longer exists
    // should be deleted rather than left implying a risk that is gone.
    const stale = [...ALLOWED_DYNAMIC_PLATFORM_IMPORTS].filter(entry => !found.has(entry)).sort();
    expect(stale, 'ALLOWED_DYNAMIC_PLATFORM_IMPORTS lists imports that no longer exist').toEqual([]);
  });

  // Type-only imports of the barrel are fine and several exist — the compiler
  // erases them, so they reach the bundle as nothing at all. It is a *value*
  // import that drags the graph in.
  it('imports core through subpaths, never its barrel at runtime', () => {
    const offenders: string[] = [];
    for (const file of tsSources(BROWSER_SRC)) {
      const source = readFileSync(file, 'utf-8');
      if (runtimeSpecifiers(source).includes(CORE_PKG)) offenders.push(relative(PACKAGES, file));
    }
    expect(
      offenders,
      `importing ${CORE_PKG} directly pulls the daemon, filesystem storage and contract tooling — and their platform builtins — into the browser graph. Import the specific core subpath instead`,
    ).toEqual([]);
  });

  // Guards the guard: if the specifier parsing ever stops seeing the imports it
  // is meant to police, every assertion above passes vacuously.
  it('parses the specifiers it is asserting over', () => {
    const barrel = readFileSync(resolve(BROWSER_SRC, 'index.ts'), 'utf-8');
    const specifiers = allSpecifiers(barrel);
    expect(specifiers.length).toBeGreaterThan(5);
    expect(specifiers.some(specifier => specifier.startsWith(`${CORE_PKG}/`))).toBe(true);
  });
});

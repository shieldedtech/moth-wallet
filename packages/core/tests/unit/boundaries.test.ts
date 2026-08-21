// Platform- and WASM-boundary guards for core.
//
// Core is documented as the isomorphic engine, but it is not uniformly
// isomorphic: a minority of modules genuinely need Node builtins, and two modules
// are imported by extension UI pages that must never pull the ledger WASM into a
// page bundle. Both rules previously lived only in header comments, which meant a
// new module could quietly join either set — and one did. The daemon subsystem
// added seven platform-coupled modules after the rule was written down, with
// nothing to notice.
//
// These tests do not forbid platform coupling. They make the real boundary
// explicit, so widening it is a decision someone makes on purpose.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allSpecifiers,
  isMidnightPackage,
  isPlatformBuiltin,
  runtimeSpecifiers,
} from '../helpers/module-imports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '../..');
const SRC = resolve(PACKAGE, 'src');
const DIST = resolve(PACKAGE, 'dist');

/**
 * The only core modules permitted to reference a `node:` builtin, statically or
 * dynamically. Anything outside this set must work in a browser and a service
 * worker as well as in Node.
 */
const NODE_BUILTIN_ALLOWLIST = new Set([
  // Contract tooling loads compiled artifacts, witnesses and args off disk, and is
  // only ever driven by the CLI, the TUI or the daemon.
  'contract/args-parser.ts',
  'contract/artifact-loader.ts',
  'contract/call.ts',
  'contract/deploy.ts',
  'contract/fungible-token.ts',
  'contract/initial-private-state.ts',
  'contract/maintenance.ts',
  'contract/witness-loader.ts',
  // The daemon is a unix-socket RPC server. It cannot be anything but Node-only.
  'daemon/api-keys.ts',
  'daemon/audit-log.ts',
  'daemon/client.ts',
  'daemon/confirmation-queue.ts',
  'daemon/index.ts',
  'daemon/server.ts',
  'daemon/wallet-handlers.ts',
  // Writes timing samples to a file for diagnostics.
  'diagnostics/file-timing-store.ts',
  // The Node-side storage and sync-state backends. Their browser counterparts live
  // in packages/browser and back onto IndexedDB.
  'storage/fs-adapter.ts',
  'storage/safe-path.ts',
  'sync/node-sync-store.ts',
  // Reads a batch file from disk.
  'wallet/batch-transfer.ts',
  // wallet-sync is the one entry that is also reachable from the browser barrel's
  // import graph. Its platform use is confined to dynamic imports inside a
  // Node-only cleanup path, which is why a browser bundle survives it — see the
  // accepted-exception list in packages/browser/tests/unit/boundaries.test.ts.
  // Making that cleanup injectable would let both entries go away.
  'sync/wallet-sync.ts',
]);

/**
 * Modules imported by extension UI pages and the dedicated wallet worker, which
 * must not drag the wallet SDK or ledger WASM into a page bundle. Their headers say
 * so; these tests are what enforce it.
 */
const WASM_FREE_MODULES = ['types/tokens.ts', 'sync/activity.ts'];

function tsSources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map(name => name.split('\\').join('/'));
}

describe('core platform boundary', () => {
  it('confines platform builtins to the allow-listed modules', () => {
    const found = new Set<string>();
    for (const relPath of tsSources(SRC)) {
      const source = readFileSync(resolve(SRC, relPath), 'utf-8');
      if (allSpecifiers(source).some(isPlatformBuiltin)) {
        found.add(relPath);
      }
    }

    const added = [...found].filter(file => !NODE_BUILTIN_ALLOWLIST.has(file)).sort();
    expect(
      added,
      'new core module importing a Node builtin — move the platform code behind a storage/sync adapter, or add it to NODE_BUILTIN_ALLOWLIST with a note on why it can never run in a browser',
    ).toEqual([]);

    // Both directions, which also guards the guard: if the specifier parsing ever
    // stopped seeing imports, `found` would be empty and this would list every
    // allow-list entry rather than passing vacuously.
    const stale = [...NODE_BUILTIN_ALLOWLIST].filter(file => !found.has(file)).sort();
    expect(
      stale,
      'NODE_BUILTIN_ALLOWLIST names modules that no longer import a platform builtin',
    ).toEqual([]);
  });

  it('allow-listed modules all exist', () => {
    const missing = [...NODE_BUILTIN_ALLOWLIST].filter(file => !existsSync(resolve(SRC, file)));
    expect(missing, 'NODE_BUILTIN_ALLOWLIST references files that were moved or deleted').toEqual([]);
  });
});

describe('core WASM-free modules', () => {
  it.each(WASM_FREE_MODULES)('%s has no runtime Midnight import', relPath => {
    const offenders = runtimeSpecifiers(readFileSync(resolve(SRC, relPath), 'utf-8')).filter(
      isMidnightPackage,
    );
    expect(
      offenders,
      `${relPath} is imported by extension UI pages; a runtime import of any Midnight package pulls the wallet SDK or ledger WASM into a page bundle. A type-only import is fine`,
    ).toEqual([]);
  });

  it.each(WASM_FREE_MODULES)('%s compiles to a module with no imports at all', relPath => {
    const compiled = resolve(DIST, relPath.replace(/\.ts$/, '.js'));
    expect(
      existsSync(compiled),
      `${relative(PACKAGE, compiled)} is missing — run \`yarn build\` before this suite`,
    ).toBe(true);

    // These two modules are pure helpers over pure data today, so the compiled
    // output should be import-free. If a legitimate local import is added this will
    // fail — that is the prompt to re-check the WASM-free promise transitively and
    // widen the assertion deliberately, not a reason to delete it.
    expect(allSpecifiers(readFileSync(compiled, 'utf-8'))).toEqual([]);
  });
});

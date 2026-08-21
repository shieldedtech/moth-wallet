// Bundle-boundary guard for the messaging module the dedicated wallet worker
// imports.
//
// `balances-json.ts` is deliberately split out from `protocol.ts` so the worker
// can serialise balances without dragging the messaging stack in: a static
// extension-API import (which `@webext-core/messaging` pulls in) throws at module
// evaluation inside a worker, where there is no extension API surface. The split
// is the fix; nothing but a header comment kept it in place, and re-merging the
// two — or adding one convenience import here — breaks the worker at load time
// rather than at a call site, which is the hardest kind of failure to attribute.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allSpecifiers, isFrom, runtimeSpecifiers } from '../../core/tests/helpers/module-imports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, '..');
const BALANCES_JSON = resolve(PACKAGE, 'lib/messaging/balances-json.ts');

const EXTENSION_API_PACKAGES = ['webextension-polyfill', '@webext-core/messaging', 'wxt/browser'];

const source = (): string => readFileSync(BALANCES_JSON, 'utf-8');

describe('wallet-worker messaging boundary', () => {
  it('balances-json imports no extension API', () => {
    const offenders = runtimeSpecifiers(source()).filter(specifier =>
      EXTENSION_API_PACKAGES.some(pkg => isFrom(specifier, pkg)),
    );
    expect(
      offenders,
      'the dedicated wallet worker imports this module, and an extension-API import throws at module evaluation there',
    ).toEqual([]);
  });

  it('balances-json has no runtime imports at all', () => {
    // Stricter than the rule above, deliberately: the module is pure
    // (de)serialisation over a single type, and the surest way to keep an
    // extension API out is to keep everything out. A legitimate runtime import
    // arriving here should fail this and be reviewed against the worker
    // constraint rather than waved through.
    expect(runtimeSpecifiers(source())).toEqual([]);
  });

  // Guards the guard: both assertions above are satisfied by an empty list, so
  // if the specifier parsing ever stopped seeing this module's imports they would
  // pass vacuously. The type-only import of WalletBalances is the canary.
  it('parses the type-only import it is meant to tolerate', () => {
    expect(allSpecifiers(source())).toContain('@shieldedtech/moth-browser');
  });
});

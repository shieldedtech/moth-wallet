// The ledger seam. Midnight hard-forks the ledger from v8 to v9, and the two
// generations coexist: v8 serves mainnet, preprod, preview and qanet; v9 serves
// the forked networks. Both can be live in one process — upstream proved the
// WASM modules do not interfere (midnight-wallet#629) — but their classes are
// distinct, so a value from one is never valid input to the other.
//
// Loading is async because these are WASM modules; access is sync because
// wallet/address.ts derives keys in a synchronous call chain that reaches the
// CLI, TUI and extension. Hence init-then-use: a caller loads the ledger its
// network needs during setup, and everything downstream reads it synchronously.
// The alternative — importing both eagerly — would put ~20MB of WASM in every
// bundle regardless of which network is in use. See ADR-0006.

import type {LedgerVersion} from '../types/network.js';

/**
 * The ledger surface, typed as v8's. v9 is structurally a superset except for
 * its signature encodings, which are `{tag, value}` rather than bare hex —
 * route those through `wallet/signature-encoding.ts` rather than reading them
 * off this type.
 */
export type LedgerModule = typeof import('@midnight-ntwrk/ledger-v8');

const loaded = new Map<LedgerVersion, LedgerModule>();
const inFlight = new Map<LedgerVersion, Promise<LedgerModule>>();
let current: LedgerVersion | undefined;

async function importLedger(version: LedgerVersion): Promise<LedgerModule> {
  // Scope note: v9 lives under @midnightntwrk (no dash), which is what the
  // wallet SDK and compact-js depend on. Matching them keeps one v9 instance in
  // the tree — two copies would fail each other's instanceof checks.
  const mod =
    version === 'v9'
      ? await import('@midnightntwrk/ledger-v9')
      : await import('@midnight-ntwrk/ledger-v8');
  return mod as unknown as LedgerModule;
}

/**
 * Load a ledger and make it current. Safe to call repeatedly: the same version
 * resolves to the same module object, and concurrent calls share one load.
 */
export async function initLedger(version: LedgerVersion): Promise<LedgerModule> {
  const already = loaded.get(version);
  if (already) {
    current = version;
    return already;
  }

  const pending = inFlight.get(version) ?? importLedger(version);
  inFlight.set(version, pending);
  try {
    const mod = await pending;
    loaded.set(version, mod);
    current = version;
    return mod;
  } finally {
    inFlight.delete(version);
  }
}

/** The current ledger. Throws if nothing has been loaded — never guesses. */
export function ledger(): LedgerModule {
  if (!current) {
    throw new Error('No ledger loaded: call initLedger(version) during setup before using the ledger');
  }
  return loaded.get(current)!;
}

/** A specific ledger, for code holding both at once. Throws if not loaded. */
export function ledgerFor(version: LedgerVersion): LedgerModule {
  const mod = loaded.get(version);
  if (!mod) throw new Error(`Ledger ${version} is not loaded: call initLedger('${version}') first`);
  return mod;
}

/** The version most recently made current, or undefined before any init. */
export function activeLedgerVersion(): LedgerVersion | undefined {
  return current;
}

/** Drop all loaded ledgers. For tests — WASM modules are otherwise process-wide. */
export function resetLedgerRegistry(): void {
  loaded.clear();
  inFlight.clear();
  current = undefined;
}

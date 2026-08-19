// The wallet-SDK seam. Companion to src/ledger: the ledger seam picks which
// ledger WASM is live, and this picks the SDK generation that matches it.
//
// Both are needed. wallet-sdk@1.2.0 binds to ledger-v8 and rejects a v9 ledger
// object at the WASM boundary — the failure that stopped a stagenet preseed
// with "expected instance of DustParameters". The v9 line is installed under an
// npm alias so both generations coexist: v8 hoisted, v9 nested, one copy of
// each ledger. See docs/plans/ledger-v9-sdk-seam.md.
//
// Only the subpaths that carry ledger objects live here. `/hd` and
// `/address-format` are measured fork-invariant — identical keys, identical
// bech32m — so their importers keep direct imports and are not routed through
// this module.

import type {LedgerVersion} from '../types/network.js';
import type {SignatureKind} from '../wallet/signature-encoding.js';
import {initLedger} from '../ledger/index.js';

/**
 * The SDK surface, typed as the v8 line's. v9 is structurally compatible for
 * everything here except `createKeystore`, whose argument shape changed — use
 * {@link createKeystoreFor} rather than calling it off this type.
 */
export interface SdkModule {
  readonly root: typeof import('@midnightntwrk/wallet-sdk');
  readonly facade: typeof import('@midnightntwrk/wallet-sdk/facade');
  readonly submission: typeof import('@midnightntwrk/wallet-sdk/capabilities/submission');
  readonly proving: typeof import('@midnightntwrk/wallet-sdk/capabilities/proving');
  readonly proverClient: typeof import('@midnightntwrk/wallet-sdk/prover-client/effect');
  readonly dust: typeof import('@midnightntwrk/wallet-sdk/dust');
  readonly dustV1: typeof import('@midnightntwrk/wallet-sdk/dust/v1');
  readonly shielded: typeof import('@midnightntwrk/wallet-sdk/shielded');
  readonly shieldedV1: typeof import('@midnightntwrk/wallet-sdk/shielded/v1');
  readonly unshielded: typeof import('@midnightntwrk/wallet-sdk/unshielded');
  readonly nodeClient: typeof import('@midnightntwrk/wallet-sdk/node-client');
}

const loaded = new Map<LedgerVersion, SdkModule>();
const inFlight = new Map<LedgerVersion, Promise<SdkModule>>();
let current: LedgerVersion | undefined;

async function importSdk(version: LedgerVersion): Promise<SdkModule> {
  // Static specifiers per branch: a bundler cannot follow a computed one, and
  // the browser build has to be able to see both.
  const mods =
    version === 'v9'
      ? await Promise.all([
          import('wallet-sdk-v9'),
          import('wallet-sdk-v9/facade'),
          import('wallet-sdk-v9/capabilities/submission'),
          import('wallet-sdk-v9/capabilities/proving'),
          import('wallet-sdk-v9/prover-client/effect'),
          import('wallet-sdk-v9/dust'),
          import('wallet-sdk-v9/dust/v1'),
          import('wallet-sdk-v9/shielded'),
          import('wallet-sdk-v9/shielded/v1'),
          import('wallet-sdk-v9/unshielded'),
          import('wallet-sdk-v9/node-client'),
        ])
      : await Promise.all([
          import('@midnightntwrk/wallet-sdk'),
          import('@midnightntwrk/wallet-sdk/facade'),
          import('@midnightntwrk/wallet-sdk/capabilities/submission'),
          import('@midnightntwrk/wallet-sdk/capabilities/proving'),
          import('@midnightntwrk/wallet-sdk/prover-client/effect'),
          import('@midnightntwrk/wallet-sdk/dust'),
          import('@midnightntwrk/wallet-sdk/dust/v1'),
          import('@midnightntwrk/wallet-sdk/shielded'),
          import('@midnightntwrk/wallet-sdk/shielded/v1'),
          import('@midnightntwrk/wallet-sdk/unshielded'),
          import('@midnightntwrk/wallet-sdk/node-client'),
        ]);

  const [root, facade, submission, proving, proverClient, dust, dustV1, shielded, shieldedV1, unshielded, nodeClient] =
    mods as unknown as SdkModule[keyof SdkModule][];

  return {
    root, facade, submission, proving, proverClient,
    dust, dustV1, shielded, shieldedV1, unshielded, nodeClient,
  } as SdkModule;
}

/**
 * Load the SDK generation for `version`, and the ledger it binds to. Safe to
 * call repeatedly; concurrent calls share one load.
 */
export async function initSdk(version: LedgerVersion): Promise<SdkModule> {
  // The SDK reaches its own ledger directly, so the two must be brought up
  // together or a caller could hold a v9 SDK over a v8 ledger.
  await initLedger(version);

  const already = loaded.get(version);
  if (already) {
    current = version;
    return already;
  }
  const pending = inFlight.get(version) ?? importSdk(version);
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

/** The current SDK. Throws if nothing is loaded — never guesses. */
export function sdk(): SdkModule {
  if (!current) {
    throw new Error('No wallet SDK loaded: call initSdk(version) during setup before using the SDK');
  }
  return loaded.get(current)!;
}

/** A specific generation, for code holding both. Throws if not loaded. */
export function sdkFor(version: LedgerVersion): SdkModule {
  const mod = loaded.get(version);
  if (!mod) throw new Error(`Wallet SDK ${version} is not loaded: call initSdk('${version}') first`);
  return mod;
}

export function activeSdkVersion(): LedgerVersion | undefined {
  return current;
}

/** Drop everything. For tests — the modules are otherwise process-wide. */
export function resetSdkRegistry(): void {
  loaded.clear();
  inFlight.clear();
  current = undefined;
}

/**
 * `createKeystore` is the one call whose shape changed across the fork: v8
 * takes the raw secret, v9 takes `{kind, secret}` where kind selects BIP-340
 * Schnorr or ECDSA over secp256k1. A v8-shaped call throws on v9, and the
 * static type here is v8's, so the compiler cannot catch it — hence this.
 *
 * `kind` is ignored on v8, which has no such concept. Note it is not cosmetic
 * on v9: it changes the unshielded address, though shielded and DUST addresses
 * are unaffected.
 */
export function createKeystoreFor(
  secret: Uint8Array,
  networkId: string,
  kind: SignatureKind = 'schnorr',
): ReturnType<SdkModule['unshielded']['createKeystore']> {
  const create = sdk().unshielded.createKeystore as unknown as (arg: unknown, networkId: string) => unknown;
  const arg = activeSdkVersion() === 'v9' ? {kind, secret} : secret;
  return create(arg, networkId) as ReturnType<SdkModule['unshielded']['createKeystore']>;
}

/**
 * The signer callback each SDK generation expects.
 *
 * The contract changed across the fork. v8 takes a synchronous
 * `(data) => Signature`; v9 takes `SignSegment = (data) => Promise<Signature>`,
 * made async so out-of-process signers (MPC, HSM) can be plugged in — the whole
 * point of ECDSA support. Handing v9 the synchronous callback gives its signing
 * service a non-thenable, which surfaces to the user as "Signer callback
 * failed" with nothing to indicate why.
 *
 * v9 keystores carry `signDataAsync` for exactly this; v8 keystores have no
 * such method, so the shape has to be chosen per generation.
 */
export function signSegmentFor(
  keystore: ReturnType<SdkModule['unshielded']['createKeystore']>,
): (data: Uint8Array) => unknown {
  if (activeSdkVersion() === 'v9') {
    const async = keystore as unknown as {signDataAsync(data: Uint8Array): Promise<unknown>};
    return (data: Uint8Array) => async.signDataAsync(data);
  }
  return (data: Uint8Array) => keystore.signData(data);
}

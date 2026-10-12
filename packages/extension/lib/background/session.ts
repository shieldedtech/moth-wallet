// Unlocked-session lifecycle. The decrypted seed lives ONLY in
// browser.storage.session: memory-backed, survives service-worker restarts,
// cleared when the browser exits. Locking happens explicitly (lock button,
// account removal, network switch) and via an inactivity auto-lock (see
// auto-lock.ts). The auto-lock defers while work is in flight
// (hasWorkInFlight), so it no longer tears the sync stack down mid-sync
// under an open panel.

import { browser } from 'wxt/browser';
import type { WalletInfo } from '@shieldedtech/moth-browser';

const SESSION_KEY = 'session';

export interface Session {
  walletName: string;
  /** User-chosen display label, mirrored from the wallet's metadata at unlock
   *  (and updated on rename) so status calls never need an offscreen round-trip. */
  walletLabel?: string;
  seedHex: string;
  /**
   * BIP-39 mnemonic, for Cardano's CIP-1852 derivation. Absent for accounts
   * imported from a raw hex seed — one never existed, so those accounts have no
   * Cardano identity.
   *
   * Held here for the same reason and with the same lifetime as `seedHex`: both
   * are cleared by lock and by browser exit. It is strictly more powerful than
   * the seed though, because it also controls Cardano funds — so it is never
   * sent to a panel, only to the offscreen document that signs with it.
   */
  cardanoMnemonic?: string;
  /**
   * Decrypted phrases for imported Cardano accounts, keyed by account id.
   *
   * Loaded once at unlock, while the passphrase is in hand. Without it, every
   * Cardano transaction on an imported account would re-prompt for the
   * passphrase — the phrase is encrypted at rest under it, and the session
   * deliberately does not keep the passphrase itself.
   *
   * Same lifetime and same protection as `cardanoMnemonic`: memory-backed
   * session storage, gone on lock and on browser exit, never sent to a panel.
   */
  cardanoImported?: Record<string, string>;
  address: string;
  addresses: WalletInfo['addresses'];
  /** Shielded (Zswap) public keys as hex — exposed to connected dApps. */
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
  network: string;
  unlockedAt: number;
}

export interface SessionStorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

function store(): SessionStorageLike {
  return browser.storage.session as unknown as SessionStorageLike;
}

export async function saveSession(session: Session): Promise<void> {
  await store().set({ [SESSION_KEY]: session });
}

export async function getSession(): Promise<Session | null> {
  const stored = await store().get(SESSION_KEY);
  return (stored[SESSION_KEY] as Session | undefined) ?? null;
}

export async function clearSession(): Promise<void> {
  await store().remove(SESSION_KEY);
}

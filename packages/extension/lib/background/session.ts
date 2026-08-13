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

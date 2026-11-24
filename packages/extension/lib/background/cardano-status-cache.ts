// The last Cardano status read per account, so the Cardano screen can show it
// at once and refresh behind it instead of waiting on the chain every visit.
//
// Held in storage.session, the same memory-backed store as the unlocked
// session: it survives service-worker restarts, and lockNow clears it.

import { browser, type Browser } from 'wxt/browser';
import type { CachedCardanoStatusDTO, CardanoStatusDTO } from '../messaging/protocol';
import type { CardanoContext } from './cardano-session';

const PREFIX = 'cardanoStatus:';

const inFlight = new Map<string, Promise<CardanoStatusDTO>>();
/** Bumped by every invalidation, so a read that started before one is not cached after it. */
const generations = new Map<string, number>();

function store(): Browser.storage.StorageArea {
  return browser.storage.session as Browser.storage.StorageArea;
}

export function cardanoStatusKey({ session, account }: Pick<CardanoContext, 'session' | 'account'>): string {
  return PREFIX + JSON.stringify([session.network, session.walletName, account.id]);
}

export async function getCachedCardanoStatus(
  key: string,
  now = Date.now(),
): Promise<CachedCardanoStatusDTO | null> {
  const cached = (await store().get(key))[key] as CachedCardanoStatusDTO | undefined;
  if (!cached) return null;
  const { status } = cached;
  // The countdown is relative to when it was read; restate it for now.
  const secondsRemaining =
    status.generatingFrom === null
      ? status.secondsRemaining
      : Math.max(0, status.generatingFrom - Math.floor(now / 1000));
  return { ...cached, status: { ...status, secondsRemaining } };
}

/**
 * Run `read` for `key` unless a read for it is already running, in which case
 * share that one. A screen that is opened, closed and reopened while a read is
 * in flight would otherwise start a second one against the same Blockfrost quota.
 */
export function readCardanoStatusOnce(
  key: string,
  read: () => Promise<CardanoStatusDTO>,
): Promise<CardanoStatusDTO> {
  const running = inFlight.get(key);
  if (running) return running;

  const generation = generations.get(key) ?? 0;
  const promise = read()
    .then(async (status) => {
      if ((generations.get(key) ?? 0) === generation) {
        await store().set({ [key]: { status, readAt: Date.now() } satisfies CachedCardanoStatusDTO });
      }
      return status;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** Forget `key`'s status, for after a transaction that changes it. */
export async function invalidateCardanoStatus(key: string): Promise<void> {
  generations.set(key, (generations.get(key) ?? 0) + 1);
  inFlight.delete(key);
  await store().remove(key);
}

/** Forget every account's status. Called on lock. */
export async function clearCardanoStatusCache(): Promise<void> {
  for (const key of inFlight.keys()) generations.set(key, (generations.get(key) ?? 0) + 1);
  inFlight.clear();
  const keys = Object.keys(await store().get(null)).filter((key) => key.startsWith(PREFIX));
  if (keys.length > 0) await store().remove(keys);
}

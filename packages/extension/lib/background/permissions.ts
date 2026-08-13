// Per-origin dApp connection grants, persisted in storage.local.

import { browser } from 'wxt/browser';

const PERMISSIONS_KEY = 'permissions.origins';

export interface OriginGrant {
  networkId: string;
  grantedAt: number;
}

type Grants = Record<string, OriginGrant>;

async function load(): Promise<Grants> {
  const stored = await browser.storage.local.get(PERMISSIONS_KEY);
  return (stored[PERMISSIONS_KEY] as Grants | undefined) ?? {};
}

async function save(grants: Grants): Promise<void> {
  await browser.storage.local.set({ [PERMISSIONS_KEY]: grants });
}

export async function isAllowed(origin: string): Promise<boolean> {
  return origin in (await load());
}

export async function grant(origin: string, networkId: string, now: number = Date.now()): Promise<void> {
  const grants = await load();
  grants[origin] = { networkId, grantedAt: now };
  await save(grants);
}

export async function revoke(origin: string): Promise<void> {
  const grants = await load();
  delete grants[origin];
  await save(grants);
}

export async function listAll(): Promise<Record<string, OriginGrant>> {
  return load();
}

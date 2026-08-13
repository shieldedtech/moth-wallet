// Background side of send-to-name: forward-resolve a `.shielded` registry name
// to a send target via the configured read API. Runs in the service worker,
// where host_permissions apply (localhost + *.midnight.network are granted; an
// arbitrary-host resolver would need a manifest entry). Never throws for a
// normal miss — every failure path returns a NameResolution with `error` set,
// so the Send UI can safe-degrade. See docs/adr/0002.

import { getSettings } from './settings';
import type { NameResolution } from '../messaging/protocol';

export async function resolveName(name: string): Promise<NameResolution> {
  const miss = (error: string): NameResolution => ({
    name,
    address: null,
    verifiedLevel: 'unverified',
    expiryEpoch: null,
    error,
  });

  const { nameResolverUrl } = await getSettings();
  if (!nameResolverUrl) return miss('No name resolver is configured — set one in Settings.');

  const url = `${nameResolverUrl}/api/names/${encodeURIComponent(name)}/resolve`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    return miss('Couldn’t reach the name resolver.');
  }
  if (res.status === 404) return miss('That name isn’t registered.');
  if (!res.ok) return miss(`Name resolver returned ${res.status}.`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return miss('Name resolver returned an invalid response.');
  }

  const b = (body ?? {}) as {
    records?: { address?: unknown };
    verifiedLevel?: unknown;
    expiryEpoch?: unknown;
  };
  const address = typeof b.records?.address === 'string' ? b.records.address : null;
  const verifiedLevel = b.verifiedLevel === 'verified' ? 'verified' : 'unverified';
  const expiryEpoch = typeof b.expiryEpoch === 'number' ? b.expiryEpoch : null;

  if (!address) {
    return { name, address: null, verifiedLevel, expiryEpoch, error: 'This name has no public address record.' };
  }
  return { name, address, verifiedLevel, expiryEpoch, error: null };
}

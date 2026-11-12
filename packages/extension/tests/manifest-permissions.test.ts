import { describe, expect, it } from 'vitest';
import { DEFAULT_NETWORKS } from '@shieldedtech/moth-wallet/types/network';
import config from '../wxt.config';

interface Manifest {
  permissions: string[];
  host_permissions: string[];
}

/** The manifest is generated per target, so resolve it the way WXT does. */
function manifestFor(browser: string): Manifest {
  const manifest = config.manifest as (env: { browser: string }) => Manifest;
  return manifest({ browser });
}

function permissionsFor(browser: string): string[] {
  return manifestFor(browser).permissions;
}

/** Whether an `https://*.domain/*` or `https://host/*` pattern covers `url`'s host. */
function covers(pattern: string, url: string): boolean {
  const { protocol, hostname } = new URL(url);
  const match = /^(https?):\/\/(\*\.)?([^/]+)\/\*$/.exec(pattern);
  if (!match || `${match[1]}:` !== protocol) return false;
  const [, , wildcard, host] = match;
  return wildcard ? hostname.endsWith(`.${host}`) : hostname === host;
}

const hostedPresetUrls = Object.values(DEFAULT_NETWORKS)
  .flatMap((network) => [network.nodeUrl, network.indexerUrl])
  .filter((url) => url.startsWith('https://'));

describe('manifest permissions', () => {
  // Chrome serves clipboard reads to an extension page whether or not the
  // permission is declared, so only stricter builds catch a missing entry.
  it.each(['chrome', 'firefox'])('declares clipboardRead on %s, which Paste reads through', (browser) => {
    expect(permissionsFor(browser)).toContain('clipboardRead');
  });

  // Moving a preset to a new domain without a matching host permission leaves
  // the extension unable to reach that network's node or indexer.
  it.each(['chrome', 'firefox'])('grants a host permission for every hosted preset endpoint on %s', (browser) => {
    const hostPermissions = manifestFor(browser).host_permissions;
    expect(hostedPresetUrls.length).toBeGreaterThan(0);
    for (const url of hostedPresetUrls) {
      expect(
        hostPermissions.some((pattern) => covers(pattern, url)),
        `${url} is not covered by ${hostPermissions.join(', ')}`,
      ).toBe(true);
    }
  });
});

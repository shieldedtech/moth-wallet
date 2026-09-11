import { describe, expect, it } from 'vitest';
import config from '../wxt.config';

/** The manifest is generated per target, so resolve it the way WXT does. */
function permissionsFor(browser: string): string[] {
  const manifest = config.manifest as (env: { browser: string }) => { permissions: string[] };
  return manifest({ browser }).permissions;
}

describe('manifest permissions', () => {
  // Chrome serves clipboard reads to an extension page whether or not the
  // permission is declared, so only stricter builds catch a missing entry.
  it.each(['chrome', 'firefox'])('declares clipboardRead on %s, which Paste reads through', (browser) => {
    expect(permissionsFor(browser)).toContain('clipboardRead');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { isAllowed, grant, revoke, listAll } from '../lib/background/permissions';

describe('per-origin permissions', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('denies unknown origins', async () => {
    expect(await isAllowed('https://dapp.example')).toBe(false);
  });

  it('grant → isAllowed → listAll', async () => {
    await grant('https://dapp.example', 'devnet', 1_000);
    await grant('https://other.example', 'devnet', 2_000);

    expect(await isAllowed('https://dapp.example')).toBe(true);
    const all = await listAll();
    expect(Object.keys(all).sort()).toEqual(['https://dapp.example', 'https://other.example']);
    expect(all['https://dapp.example']).toEqual({ networkId: 'devnet', grantedAt: 1_000 });
  });

  it('revoke removes a single origin', async () => {
    await grant('https://dapp.example', 'devnet');
    await grant('https://other.example', 'devnet');
    await revoke('https://dapp.example');

    expect(await isAllowed('https://dapp.example')).toBe(false);
    expect(await isAllowed('https://other.example')).toBe(true);
  });

  it('does not treat prefixes or subdomains as granted', async () => {
    await grant('https://dapp.example', 'devnet');
    expect(await isAllowed('https://dapp.example.evil.com')).toBe(false);
    expect(await isAllowed('https://sub.dapp.example')).toBe(false);
    expect(await isAllowed('http://dapp.example')).toBe(false);
  });
});

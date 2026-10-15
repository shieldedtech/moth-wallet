// Everything moth persists follows MOTH_HOME, not just the keystore and socket.
// See the on-disk root guard in boundaries.test.ts.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeSyncStateStore } from '../../src/sync/node-sync-store.js';
import { AuditLog } from '../../src/daemon/audit-log.js';
import { ApiKeyStore } from '../../src/daemon/api-keys.js';

describe('MOTH_HOME applies to every on-disk default', () => {
  let home: string;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.MOTH_HOME;
    home = mkdtempSync(join(tmpdir(), 'moth-home-'));
    process.env.MOTH_HOME = home;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.MOTH_HOME;
    else process.env.MOTH_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it('sync state store', async () => {
    await new NodeSyncStateStore().put('sync/preprod/w/state', 'x');
    expect(existsSync(join(home, 'sync', 'preprod', 'w', 'state'))).toBe(true);
  });

  it('audit log', () => {
    new AuditLog().record({ ts: new Date(0).toISOString(), kind: 'lifecycle', wallet: 'w', network: 'preprod', event: 'daemon-start' });
    expect(existsSync(join(home, 'daemon-audit.log'))).toBe(true);
  });

  it('API key store', () => {
    new ApiKeyStore();
    expect(existsSync(join(home, 'api-keys'))).toBe(true);
  });
});

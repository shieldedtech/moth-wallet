import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

// An approval answered while an auto-lock tick was reading activity times used
// to resume its op after the tick had decided to lock, so the approved request
// ran against a locked wallet. These pin that a tick never locks under it.

vi.mock('../lib/background/offscreen-client', () => ({ offscreen: {} }));
vi.mock('../lib/background/keepalive', () => ({ acquireKeepalive: vi.fn(), releaseKeepalive: vi.fn() }));

// A real op counter: the race is between it and the tick's reads.
let ops = 0;
vi.mock('../lib/background/sync-service', () => ({
  beginOp: () => { ops++; },
  endOp: () => { ops = Math.max(0, ops - 1); },
  hasOpsInFlight: () => ops > 0,
  syncDefersAutoLock: () => false,
  hasOpenPorts: () => true,
  broadcastApproval: vi.fn(),
  broadcastSessionLocked: vi.fn(),
  clearSnapshot: vi.fn(() => Promise.resolve()),
  teardown: vi.fn(() => Promise.resolve()),
  stopSync: vi.fn(),
  startSync: vi.fn(),
  getSnapshot: vi.fn(),
  getSetupTabIds: vi.fn(() => []),
}));

const duringUserActivityRead = vi.fn<() => void>();
vi.mock('../lib/background/auto-lock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/background/auto-lock')>();
  return {
    ...actual,
    getLastUserActivity: async () => {
      duringUserActivityRead();
      return actual.getLastUserActivity();
    },
  };
});

import { enforceAutoLock } from '../lib/background/handlers';
import { getPendingApproval, rejectPendingApprovals, requestApproval, resolveApproval } from '../lib/background/approvals';
import { getLastActivity, getLastUserActivity, recordActivity } from '../lib/background/auto-lock';
import { getSession, saveSession, type Session } from '../lib/background/session';
import { updateSettings } from '../lib/background/settings';

const SESSION = {
  walletName: 'alice',
  seedHex: 'ab'.repeat(32),
  network: 'undeployed',
  unlockedAt: 1,
} as unknown as Session;

/** Start an approval the way dispatch does, inside an op, and wait for it to show. */
async function openApproval(): Promise<{ decision: Promise<boolean>; id: string }> {
  ops++;
  const decision = requestApproval('connect', 'https://dapp.example', {});
  const shown = await vi.waitFor(async () => {
    const approval = await getPendingApproval();
    expect(approval).not.toBeNull();
    return approval!;
  });
  // Let the activity that showing it records land, then age every timestamp
  // past the window so the tick decides to lock.
  await vi.waitFor(async () => expect(await getLastActivity()).not.toBeNull());
  await recordActivity(Date.now() - 10 * 60_000);
  return { decision, id: shown.id };
}

describe('enforceAutoLock', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    ops = 0;
    duringUserActivityRead.mockReset();
    rejectPendingApprovals();
    await updateSettings({ autoLockMinutes: 1 });
    await saveSession(SESSION);
  });

  it('locks and rejects an approval left waiting', async () => {
    const { decision } = await openApproval();
    await enforceAutoLock();
    await expect(decision).resolves.toBe(false);
    expect(await getSession()).toBeNull();
  });

  it('does not lock under an approval answered while it reads activity', async () => {
    const { decision, id } = await openApproval();
    duringUserActivityRead.mockImplementationOnce(() => resolveApproval(id, true));
    await enforceAutoLock();
    await expect(decision).resolves.toBe(true);
    expect(ops).toBe(1);
    expect(await getSession()).not.toBeNull();
  });

  it('gives a newly shown approval a full window, as dApp activity', async () => {
    const before = await getLastUserActivity();
    ops++;
    void requestApproval('connect', 'https://dapp.example', {});
    await vi.waitFor(async () => expect(await getLastActivity()).not.toBeNull());
    expect(Date.now() - (await getLastActivity())!).toBeLessThan(5_000);
    expect(await getLastUserActivity()).toBe(before);
  });
});

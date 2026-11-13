import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

const hasOpenPorts = vi.fn(() => false);
const broadcastApproval = vi.fn();
const beginOp = vi.fn();
const endOp = vi.fn();
const hasOpsInFlight = vi.fn(() => true);
vi.mock('../lib/background/sync-service', () => ({
  hasOpsInFlight: () => hasOpsInFlight(),
  hasOpenPorts: () => hasOpenPorts(),
  broadcastApproval: (id: string | null) => broadcastApproval(id),
  beginOp: () => beginOp(),
  endOp: () => endOp(),
}));

const acquireKeepalive = vi.fn();
const releaseKeepalive = vi.fn();
vi.mock('../lib/background/keepalive', () => ({
  acquireKeepalive: () => acquireKeepalive(),
  releaseKeepalive: () => releaseKeepalive(),
}));

import { hasPendingApproval, rejectPendingApprovals, requestApproval, resolveApproval } from '../lib/background/approvals';

describe('approval surfaces', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    hasOpenPorts.mockReset().mockReturnValue(false);
    broadcastApproval.mockReset();
    acquireKeepalive.mockReset();
    releaseKeepalive.mockReset();
    beginOp.mockReset();
    endOp.mockReset();
    hasOpsInFlight.mockReset().mockReturnValue(true);
  });

  // A dApp once held the wallet unlocked by leaving an approval unanswered:
  // waiting on the user no longer counts as work in flight, and auto-lock rejects it.
  it('does not count as work in flight while waiting, and auto-lock can reject it', async () => {
    hasOpenPorts.mockReturnValue(true);
    const decision = requestApproval('connect', 'https://dapp.example', {});
    await vi.waitFor(() => expect(endOp).toHaveBeenCalledTimes(1));
    expect(hasPendingApproval()).toBe(true);
    rejectPendingApprovals();
    await expect(decision).resolves.toBe(false);
    expect(beginOp).toHaveBeenCalledTimes(1);
    expect(hasPendingApproval()).toBe(false);
  });

  it('resumes the op in the same step as the decision', async () => {
    hasOpenPorts.mockReturnValue(true);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000002');
    const decision = requestApproval('connect', 'https://dapp.example', {});
    await vi.waitFor(() => expect(endOp).toHaveBeenCalledTimes(1));
    resolveApproval('00000000-0000-4000-8000-000000000002', true);
    expect(beginOp).toHaveBeenCalledTimes(1);
    await expect(decision).resolves.toBe(true);
    expect(beginOp).toHaveBeenCalledTimes(1);
  });

  // endOp clamps at zero, so pairing it with beginOp outside an op would leave
  // one counted for good and disable auto-lock.
  it('leaves the op count alone when the caller holds no op', async () => {
    hasOpenPorts.mockReturnValue(true);
    hasOpsInFlight.mockReturnValue(false);
    const decision = requestApproval('connect', 'https://dapp.example', {});
    await vi.waitFor(() => expect(hasPendingApproval()).toBe(true));
    rejectPendingApprovals();
    await expect(decision).resolves.toBe(false);
    expect(endOp).not.toHaveBeenCalled();
    expect(beginOp).not.toHaveBeenCalled();
  });

  it('opens a closed side panel before awaiting approval persistence', async () => {
    let persistApproval!: () => void;
    const persistence = new Promise<void>((resolve) => {
      persistApproval = resolve;
    });
    vi.spyOn(fakeBrowser.storage.session, 'set').mockReturnValue(persistence);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');

    const open = vi.fn().mockResolvedValue(undefined);
    (fakeBrowser as typeof fakeBrowser & { sidePanel: { open: typeof open } }).sidePanel = { open };

    const approval = requestApproval('connect', 'https://dapp.example', { networkId: 'devnet' }, 42);

    expect(open).toHaveBeenCalledWith({ tabId: 42 });
    expect(broadcastApproval).not.toHaveBeenCalled();

    persistApproval();
    await vi.waitFor(() => expect(broadcastApproval).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'));

    resolveApproval('00000000-0000-4000-8000-000000000001', true);
    await expect(approval).resolves.toBe(true);
  });

  it('queues concurrent approvals FIFO — resolving one surfaces the next, none orphaned', async () => {
    const ID1 = '00000000-0000-4000-8000-000000000001';
    const ID2 = '00000000-0000-4000-8000-000000000002';
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(ID1).mockReturnValueOnce(ID2);
    const open = vi.fn().mockResolvedValue(undefined);
    (fakeBrowser as typeof fakeBrowser & { sidePanel: { open: typeof open } }).sidePanel = { open };

    // Two approvals requested while the first is still pending (a dApp deriving
    // several app secrets at once). The first surfaces; the second waits.
    const first = requestApproval('deriveAppSecret', 'https://dapp.example', { domain: 'a' }, 7);
    await vi.waitFor(() => expect(broadcastApproval).toHaveBeenCalledWith(ID1));
    const second = requestApproval('deriveAppSecret', 'https://dapp.example', { domain: 'b' }, 7);

    // Resolving the first must surface the second (not blank the panel) and let
    // the second's promise resolve — the bug was it hung forever.
    resolveApproval(ID1, true);
    await expect(first).resolves.toBe(true);
    await vi.waitFor(() => expect(broadcastApproval).toHaveBeenCalledWith(ID2));

    resolveApproval(ID2, true);
    await expect(second).resolves.toBe(true);
  });
});

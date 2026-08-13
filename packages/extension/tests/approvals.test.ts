import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

const hasOpenPorts = vi.fn(() => false);
const broadcastApproval = vi.fn();
vi.mock('../lib/background/sync-service', () => ({
  hasOpenPorts: () => hasOpenPorts(),
  broadcastApproval: (id: string | null) => broadcastApproval(id),
}));

const acquireKeepalive = vi.fn();
const releaseKeepalive = vi.fn();
vi.mock('../lib/background/keepalive', () => ({
  acquireKeepalive: () => acquireKeepalive(),
  releaseKeepalive: () => releaseKeepalive(),
}));

import { requestApproval, resolveApproval } from '../lib/background/approvals';

describe('approval surfaces', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    hasOpenPorts.mockReset().mockReturnValue(false);
    broadcastApproval.mockReset();
    acquireKeepalive.mockReset();
    releaseKeepalive.mockReset();
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

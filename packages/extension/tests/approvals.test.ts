import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';

const hasVisiblePanel = vi.fn(() => false);
const broadcastApproval = vi.fn();
const beginOp = vi.fn();
const endOp = vi.fn();
const hasOpsInFlight = vi.fn(() => true);
vi.mock('../lib/background/sync-service', () => ({
  hasOpsInFlight: () => hasOpsInFlight(),
  hasVisiblePanel: () => hasVisiblePanel(),
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

import {
  hasPendingApproval,
  rejectApprovalsFrom,
  rejectPendingApprovals,
  requestApproval,
  requesterKey,
  resolveApproval,
  watchRequester,
} from '../lib/background/approvals';

describe('approval surfaces', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    hasVisiblePanel.mockReset().mockReturnValue(false);
    broadcastApproval.mockReset();
    acquireKeepalive.mockReset();
    releaseKeepalive.mockReset();
    beginOp.mockReset();
    endOp.mockReset();
    hasOpsInFlight.mockReset().mockReturnValue(true);
    // Approval state is module-level; a test that leaves one pending must not
    // hold the next test's prompt in the queue.
    rejectPendingApprovals();
  });

  // A dApp once held the wallet unlocked by leaving an approval unanswered:
  // waiting on the user no longer counts as work in flight, and auto-lock rejects it.
  it('does not count as work in flight while waiting, and auto-lock can reject it', async () => {
    hasVisiblePanel.mockReturnValue(true);
    const decision = requestApproval('connect', 'https://dapp.example', {});
    await vi.waitFor(() => expect(endOp).toHaveBeenCalledTimes(1));
    expect(hasPendingApproval()).toBe(true);
    rejectPendingApprovals();
    await expect(decision).resolves.toBe(false);
    expect(beginOp).toHaveBeenCalledTimes(1);
    expect(hasPendingApproval()).toBe(false);
  });

  it('resumes the op in the same step as the decision', async () => {
    hasVisiblePanel.mockReturnValue(true);
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
    hasVisiblePanel.mockReturnValue(true);
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

  // A page reloaded or closed with its prompt open used to leave that prompt at the
  // head of the queue: every later request waited behind a decision nobody could
  // deliver, and the prompt the user then answered was not the one they had just made.
  it('drops a pending approval when its page goes away and surfaces the next one', async () => {
    const ID1 = '00000000-0000-4000-8000-000000000001';
    const ID2 = '00000000-0000-4000-8000-000000000002';
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(ID1).mockReturnValueOnce(ID2);
    hasVisiblePanel.mockReturnValue(true);

    const first = requestApproval('deriveAppSecret', 'https://dapp.example', { domain: 'a' }, 7, undefined, '7/0/doc-1');
    await vi.waitFor(() => expect(broadcastApproval).toHaveBeenCalledWith(ID1));
    const second = requestApproval('deriveAppSecret', 'https://dapp.example', { domain: 'a' }, 7, undefined, '7/0/doc-2');
    await vi.waitFor(() => expect(hasPendingApproval()).toBe(true));
    expect(broadcastApproval).not.toHaveBeenCalledWith(ID2);

    rejectApprovalsFrom('7/0/doc-1');
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect(broadcastApproval).toHaveBeenCalledWith(ID2));

    resolveApproval(ID2, true);
    await expect(second).resolves.toBe(true);
  });

  it('leaves approvals from other pages alone', async () => {
    const ID1 = '00000000-0000-4000-8000-000000000001';
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(ID1);
    hasVisiblePanel.mockReturnValue(true);

    const pending = requestApproval('connect', 'https://dapp.example', {}, 7, undefined, '7/0/doc-1');
    await vi.waitFor(() => expect(broadcastApproval).toHaveBeenCalledWith(ID1));

    rejectApprovalsFrom('7/0/doc-2');
    rejectApprovalsFrom('8/0/doc-1');
    expect(hasPendingApproval()).toBe(true);

    resolveApproval(ID1, true);
    await expect(pending).resolves.toBe(true);
  });

  it('closes the popup window of a dropped approval', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    // No user gesture (Dust Dice derives on page arrival): the panel cannot open.
    const open = vi.fn().mockRejectedValue(new Error('sidePanel.open() may only be called in response to a user gesture'));
    (fakeBrowser as typeof fakeBrowser & { sidePanel: { open: typeof open } }).sidePanel = { open };
    const create = vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({ id: 55 } as never);
    const remove = vi.spyOn(fakeBrowser.windows, 'remove').mockResolvedValue(undefined);

    const pending = requestApproval('deriveAppSecret', 'https://dapp.example', { domain: 'a' }, 7, undefined, '7/0/doc-1');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    rejectApprovalsFrom('7/0/doc-1');
    await expect(pending).resolves.toBe(false);
    expect(remove).toHaveBeenCalledWith(55);
  });

  it('drops a page\'s approvals when its connector port disconnects', async () => {
    const ID1 = '00000000-0000-4000-8000-000000000001';
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(ID1);
    hasVisiblePanel.mockReturnValue(true);

    let onDisconnect: (() => void) | undefined;
    const port = {
      sender: { tab: { id: 7 }, frameId: 0, documentId: 'doc-1' },
      onDisconnect: { addListener: (listener: () => void) => void (onDisconnect = listener) },
    };
    watchRequester(port as never);

    const pending = requestApproval('connect', 'https://dapp.example', {}, 7, undefined, requesterKey(port.sender));
    await vi.waitFor(() => expect(broadcastApproval).toHaveBeenCalledWith(ID1));

    onDisconnect!();
    await expect(pending).resolves.toBe(false);
    expect(hasPendingApproval()).toBe(false);
  });
});

describe('requesterKey', () => {
  it('names a document on Chrome, so a reload is a new requester', () => {
    expect(requesterKey({ tab: { id: 7 }, frameId: 0, documentId: 'abc' })).toBe('7/0/abc');
    expect(requesterKey({ tab: { id: 7 }, frameId: 0, documentId: 'def' })).not.toBe('7/0/abc');
  });

  it('falls back to the tab and frame where there is no document id', () => {
    expect(requesterKey({ tab: { id: 7 } })).toBe('7/0/');
    expect(requesterKey({ tab: { id: 7 }, frameId: 3 })).toBe('7/3/');
  });

  it('has nothing to say for a sender that is not a tab', () => {
    expect(requesterKey(undefined)).toBeUndefined();
    expect(requesterKey({ frameId: 0 })).toBeUndefined();
  });
});

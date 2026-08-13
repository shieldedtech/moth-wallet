// Pending dApp approval requests. Per the design, requests surface in the
// side panel when possible; a small popup window is the fallback (e.g. when
// the panel can't be opened without a user gesture). The promise resolves
// when the user decides or the surface closes (= reject).
// Resolver callbacks live in service-worker memory: if the SW dies mid-
// approval the dApp's promise dies with it — accepted MVP limitation, the
// keepalive makes it rare.

import { browser, type Browser } from 'wxt/browser';
import { acquireKeepalive, releaseKeepalive } from './keepalive';
import { hasOpenPorts, broadcastApproval } from './sync-service';

export interface PendingApproval {
  id: string;
  kind: 'connect' | 'transfer' | 'signData' | 'deriveAppSecret' | 'balance';
  origin: string;
  /** kind-specific display data (amounts as strings) */
  payload: unknown;
  createdAt: number;
}

const APPROVAL_PREFIX = 'approval.';

const resolvers = new Map<string, { resolve: (approved: boolean) => void; windowId?: number }>();
let activeApprovalId: string | null = null;

function sessionStore(): Browser.storage.StorageArea {
  return browser.storage.session as Browser.storage.StorageArea;
}

export async function getApproval(id: string): Promise<PendingApproval | null> {
  const stored = await sessionStore().get(APPROVAL_PREFIX + id);
  return (stored[APPROVAL_PREFIX + id] as PendingApproval | undefined) ?? null;
}

export async function getPendingApproval(): Promise<PendingApproval | null> {
  return activeApprovalId ? getApproval(activeApprovalId) : null;
}

/** Ask Chrome to open a closed panel while the dApp click's user activation is
 * still live. Call this at connector dispatch entry; even a storage read or
 * tabs.get() can put sidePanel.open() too late. */
export function prepareApprovalPanel(senderTabId?: number): Promise<boolean> {
  if (hasOpenPorts()) return Promise.resolve(true);

  const sidePanel = (browser as any).sidePanel;
  if (senderTabId === undefined || !sidePanel?.open) return Promise.resolve(false);

  try {
    return Promise.resolve(sidePanel.open({ tabId: senderTabId })).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** Popup fallback for browsers without sidePanel.open() and requests where
 * Chrome no longer considers the call part of a user gesture. */
async function openApprovalWindow(id: string): Promise<number | undefined> {
  const approvalWindow = await browser.windows.create({
    type: 'popup',
    width: 400,
    height: 640,
    url: browser.runtime.getURL(`/approval.html?id=${id}`),
  });
  return approvalWindow?.id;
}

export async function requestApproval(
  kind: PendingApproval['kind'],
  origin: string,
  payload: unknown,
  senderTabId?: number,
  preparedPanel?: Promise<boolean>,
): Promise<boolean> {
  const id = crypto.randomUUID();
  const approval: PendingApproval = { id, kind, origin, payload, createdAt: Date.now() };

  // Start persistence before using the prepared panel result, and finish it
  // before broadcasting the approval or loading the popup fallback.
  const persistence = sessionStore().set({ [APPROVAL_PREFIX + id]: approval });
  const panelOpened = preparedPanel ?? prepareApprovalPanel(senderTabId);

  acquireKeepalive();
  let windowId: number | undefined;
  try {
    await persistence;
    if (!(await panelOpened)) windowId = await openApprovalWindow(id);

    const decision = new Promise<boolean>((resolve) => {
      resolvers.set(id, { resolve, windowId });
    });
    // A dApp can request several approvals at once (e.g. deriveAppSecret for
    // multiple domains). Surface only when nothing else is mid-decision —
    // preempting would blank the approval the user is looking at and orphan the
    // others. Queued approvals drain FIFO as each resolves (see finally).
    if (activeApprovalId === null) {
      activeApprovalId = id;
      broadcastApproval(id);
    }
    return await decision;
  } finally {
    resolvers.delete(id);
    releaseKeepalive();
    void sessionStore().remove(APPROVAL_PREFIX + id);
    if (windowId !== undefined) void browser.windows.remove(windowId).catch(() => {});
    // If the resolved approval was the one on screen, advance to the next
    // queued approval (FIFO by insertion order) rather than clearing — else
    // concurrent approvals would hang unresolved.
    if (activeApprovalId === id) {
      const next = (resolvers.keys().next().value as string | undefined) ?? null;
      activeApprovalId = next;
      broadcastApproval(next);
    }
  }
}

export function resolveApproval(id: string, approved: boolean): void {
  resolvers.get(id)?.resolve(approved);
}

/** True while a dApp approval is awaiting a decision. The approval surface may
 *  hold no balances port (e.g. the popup window), so the idle/teardown check
 *  consults this to avoid tearing the wallet down under a pending decision. */
export function hasPendingApproval(): boolean {
  return resolvers.size > 0;
}

/** Wire once from the background entrypoint: closing the window = reject. */
export function watchApprovalWindows(): void {
  browser.windows.onRemoved.addListener((windowId) => {
    for (const [, entry] of resolvers) {
      if (entry.windowId === windowId) entry.resolve(false);
    }
  });
}

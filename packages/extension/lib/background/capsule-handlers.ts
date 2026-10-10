// The capsule runtime's dApp API, background side: the `capsule*` connector requests the content
// script relays, each run under the unlocked session for the origin the sender attests, forwarded
// to the runtime in the offscreen worker. The runtime asks its own questions (a contract to
// connect to, a field to read, a transaction to approve) back through `os/capsuleConsent`; they
// are shown as approvals like the standard connector's, and answered. Its events reach the tab
// that watches the session.

import { browser, type Browser } from 'wxt/browser';
import type { ConnectRequest, DescribeRequest, ReadLocalStateRequest, TransactionBlueprint } from '@shieldedtech/capsule-blueprint';
import { CAPSULE_METHODS, type CapsuleCall, type CapsuleErrorDTO, type CapsuleMethod } from '../capsule/protocol';
import { offscreenOn } from '../offscreen/messaging';
import { onMessage, sendMessage } from '../messaging/protocol';
import { connectorError } from '../connector/errors';
import { getNetworkConfig } from './settings';
import { getSession, type Session } from './session';
import { isAllowed, grant } from './permissions';
import { requestApproval } from './approvals';
import { offscreen } from './offscreen-client';

/** A refusal the runtime gave, carried to the page as the blueprint's own code, reason and path. */
export class CapsuleRefusal extends Error {
  constructor(readonly capsule: CapsuleErrorDTO) {
    super(`${capsule.code}: ${capsule.reason}`);
    this.name = 'CapsuleRefusal';
  }
}

const refusal = (code: string, reason: string): CapsuleRefusal => new CapsuleRefusal({ code, reason });

export function isCapsuleMethod(method: string): method is CapsuleMethod {
  return (CAPSULE_METHODS as readonly string[]).includes(method);
}

// The runtime's consents arrive from the worker, not from a tab, so the tab a dApp last spoke
// from is remembered per origin to open the panel beside it. A consent comes during the request
// that caused it, which holds the keepalive, so memory suffices for those.
const originTabs = new Map<string, number>();
const originPanels = new Map<string, Promise<boolean>>();

// An event comes whenever the chain answers, long after the request, by which time Chrome may
// have ended this service worker and started another; the tab that watches each session is kept
// in session storage, which outlives the worker, and refreshed by every request that names it.
const SESSION_TABS_KEY = 'capsule.sessionTabs';

function sessionStore(): Browser.storage.StorageArea {
  return browser.storage.session as Browser.storage.StorageArea;
}

async function loadSessionTabs(): Promise<Record<string, number>> {
  const stored = await sessionStore().get(SESSION_TABS_KEY);
  return (stored[SESSION_TABS_KEY] as Record<string, number> | undefined) ?? {};
}

async function rememberSessionTab(session: string, tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  const tabs = await loadSessionTabs();
  if (tabs[session] === tabId) return;
  tabs[session] = tabId;
  await sessionStore().set({ [SESSION_TABS_KEY]: tabs });
}

async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw refusal('NotConnected', 'locked');
  return session;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw connectorError('InvalidRequest', `${what} must be a non-empty string`);
  return value;
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw connectorError('InvalidRequest', `${what} must be an object`);
  return value;
}

/** An error from the offscreen hop is the runtime's own when it kept the blueprint's fields across the two serializations. */
function asRefusal(error: unknown): CapsuleRefusal {
  if (error instanceof CapsuleRefusal) return error;
  const fields = error as { name?: unknown; code?: unknown; reason?: unknown; path?: unknown } | null;
  if (fields?.name === 'BlueprintError' && typeof fields.code === 'string' && typeof fields.reason === 'string') {
    return new CapsuleRefusal({
      code: fields.code,
      reason: fields.reason,
      ...(Array.isArray(fields.path) ? { path: fields.path as Array<string | number> } : {}),
    });
  }
  console.warn('[capsule] a request failed in the wallet', error);
  return refusal('InternalError', 'unexpected');
}

export async function capsuleDispatch(
  origin: string,
  method: CapsuleMethod,
  params: unknown[],
  senderTabId?: number,
  preparedPanel?: Promise<boolean>,
): Promise<unknown> {
  const session = await requireSession();
  const network = await getNetworkConfig();
  if (senderTabId !== undefined) originTabs.set(origin, senderTabId);
  if (preparedPanel !== undefined) originPanels.set(origin, preparedPanel);
  const call: CapsuleCall = { seedHex: session.seedHex, walletName: session.walletName, network, origin };
  try {
    switch (method) {
      case 'capsuleConnect': {
        const request = requireObject(params[0] ?? {}, 'The connect request') as ConnectRequest;
        const result = await offscreen.capsuleConnect({ ...call, request });
        // One consent: the runtime's screen also stood for the wallet's own per-origin grant,
        // which the standard connector methods check, so the dApp needs no second connect.
        if (!(await isAllowed(origin))) await grant(origin, network.id);
        await rememberSessionTab(result.session, senderTabId);
        return result;
      }
      case 'capsuleDescribe': {
        const sessionId = requireString(params[0], 'The session');
        const request = requireObject(params[1], 'The describe request') as DescribeRequest;
        await rememberSessionTab(sessionId, senderTabId);
        return await offscreen.capsuleDescribe({ ...call, session: sessionId, request });
      }
      case 'capsuleSubmitBlueprint':
      case 'capsuleMakeTransaction':
      case 'capsuleEstimate': {
        const sessionId = requireString(params[0], 'The session');
        const document = requireObject(params[1], 'The document') as TransactionBlueprint;
        await rememberSessionTab(sessionId, senderTabId);
        if (method === 'capsuleSubmitBlueprint') return await offscreen.capsuleSubmitBlueprint({ ...call, session: sessionId, document });
        if (method === 'capsuleMakeTransaction') return await offscreen.capsuleMakeTransaction({ ...call, session: sessionId, document });
        return await offscreen.capsuleEstimate({ ...call, session: sessionId, document });
      }
      case 'capsuleReadLocalState': {
        const sessionId = requireString(params[0], 'The session');
        const request = requireObject(params[1], 'The read request') as ReadLocalStateRequest;
        await rememberSessionTab(sessionId, senderTabId);
        return await offscreen.capsuleReadLocalState({ ...call, session: sessionId, request });
      }
      case 'capsuleWatch': {
        const sessionId = requireString(params[0], 'The session');
        const watch = params[1] === true;
        await rememberSessionTab(sessionId, senderTabId);
        await offscreen.capsuleWatch({ ...call, session: sessionId, watch });
        return null;
      }
      case 'capsuleDisconnect': {
        const sessionId = requireString(params[0], 'The session');
        await offscreen.capsuleDisconnect({ ...call, session: sessionId });
        return null;
      }
    }
  } catch (error) {
    throw asRefusal(error);
  }
}

/** Wire once from the background entrypoint: the runtime's consents and events, and the inspector's read. */
export function registerCapsuleHandlers(): void {
  offscreenOn('os/capsuleConsent', async ({ data }) => {
    const tabId = originTabs.get(data.origin);
    const prepared = originPanels.get(data.origin);
    originPanels.delete(data.origin);
    const payload = data.kind === 'capsuleConnect' ? { ...data, firstTime: !(await isAllowed(data.origin)) } : data;
    return requestApproval(data.kind, data.origin, payload, tabId, prepared);
  });
  offscreenOn('os/eventCapsule', async ({ data }) => {
    const tabId = (await loadSessionTabs())[data.session];
    if (tabId === undefined) return;
    await sendMessage('capsuleEvent', data, tabId).catch(() => {});
  });
  onMessage('capsuleList', async () => {
    const session = await requireSession();
    const network = await getNetworkConfig();
    return offscreen.capsuleList({ seedHex: session.seedHex, walletName: session.walletName, network });
  });
  onMessage('capsuleGrantsList', async () => {
    const session = await requireSession();
    const network = await getNetworkConfig();
    return offscreen.capsuleGrants({ seedHex: session.seedHex, walletName: session.walletName, network });
  });
  onMessage('capsuleGrantRevoke', async ({ data }) => {
    const session = await requireSession();
    const network = await getNetworkConfig();
    await offscreen.capsuleRevoke({ seedHex: session.seedHex, walletName: session.walletName, network, ...data });
  });
}

/** Takes a site's capsule grants under the unlocked account with the site's own permission, so one revoke means both. */
export async function revokeCapsuleGrantsOf(origin: string): Promise<void> {
  const session = await requireSession().catch(() => undefined);
  if (session === undefined) {
    return;
  }
  const network = await getNetworkConfig();
  await offscreen.capsuleRevoke({ seedHex: session.seedHex, walletName: session.walletName, network, origin }).catch(() => {});
}

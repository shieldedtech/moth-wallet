import { describe, it, expect, vi } from 'vitest';
import {
  PAGE_REQUEST_EVENT,
  createPageClient,
  isPageRequest,
  isPageResponse,
  type PageRequestEnvelope,
  type PageResponseEnvelope,
} from '../lib/messaging/page-transport';

function makeError(e: { code: string; reason: string }): Error {
  return Object.assign(new Error(e.reason), e);
}

function setup() {
  const posted: PageRequestEnvelope[] = [];
  const eventTypes: string[] = [];
  let deliver: (event: MessageEvent) => void = () => {};
  let counter = 0;
  const client = createPageClient(
    {
      dispatchEvent: (event: Event) => {
        eventTypes.push(event.type);
        posted.push(JSON.parse((event as CustomEvent<string>).detail) as PageRequestEnvelope);
        return true;
      },
    } as Pick<Window, 'dispatchEvent'>,
    (handler) => {
      deliver = handler;
    },
    makeError,
    () => `id-${counter++}`,
  );
  const respond = (envelope: PageResponseEnvelope) => deliver({ data: envelope } as MessageEvent);
  return { client, posted, eventTypes, respond };
}

describe('page transport', () => {
  it('correlates responses by id', async () => {
    const { client, posted, eventTypes, respond } = setup();

    const first = client.request('getUnshieldedBalances', '[]');
    const second = client.request('getDustBalance', '[]');
    expect(posted).toHaveLength(2);
    expect(eventTypes).toEqual([PAGE_REQUEST_EVENT, PAGE_REQUEST_EVENT]);

    // answer out of order
    respond({ __moth: true, dir: 'cs->page', id: posted[1]!.id, ok: true, resultJson: '"dust"' });
    respond({ __moth: true, dir: 'cs->page', id: posted[0]!.id, ok: true, resultJson: '"balances"' });

    await expect(second).resolves.toBe('"dust"');
    await expect(first).resolves.toBe('"balances"');
  });

  it('rejects with the connector error shape', async () => {
    const { client, posted, respond } = setup();
    const call = client.request('connect', '["devnet"]');
    respond({
      __moth: true,
      dir: 'cs->page',
      id: posted[0]!.id,
      ok: false,
      error: { code: 'Rejected', reason: 'User rejected the connection request' },
    });
    await expect(call).rejects.toMatchObject({ code: 'Rejected' });
  });

  it('ignores unrelated and malformed messages', async () => {
    const { client, posted, respond } = setup();
    const call = client.request('connect', '[]');

    respond({} as PageResponseEnvelope); // malformed
    respond({ __moth: true, dir: 'cs->page', id: 'unknown', ok: true, resultJson: '1' });
    // request envelopes echoing back must not resolve anything
    respond(posted[0] as unknown as PageResponseEnvelope);

    respond({ __moth: true, dir: 'cs->page', id: posted[0]!.id, ok: true, resultJson: 'true' });
    await expect(call).resolves.toBe('true');
  });

  it('times out', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup();
      const call = client.request('connect', '[]', 1_000);
      const assertion = expect(call).rejects.toMatchObject({ code: 'InternalError' });
      vi.advanceTimersByTime(1_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('envelope guards reject foreign shapes', () => {
    expect(isPageRequest({ __moth: true, dir: 'page->cs', id: 'x', method: 'connect', paramsJson: '[]' })).toBe(true);
    expect(isPageRequest({ dir: 'page->cs', id: 'x', method: 'connect', paramsJson: '[]' })).toBe(false);
    expect(isPageRequest(null)).toBe(false);
    expect(isPageResponse({ __moth: true, dir: 'cs->page', id: 'x', ok: true })).toBe(true);
    expect(isPageResponse({ __moth: true, dir: 'page->cs', id: 'x', ok: true })).toBe(false);
  });
});

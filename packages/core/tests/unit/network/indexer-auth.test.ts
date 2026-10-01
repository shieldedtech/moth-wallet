import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  __resetIndexerAuthForTests,
  hasIndexerAuthHeader,
  indexerWebSocketImpl,
  installIndexerAuthHeader,
  parseAuthHeader,
  withIndexerAuth,
  withIndexerAuthWebSocket,
} from '../../../src/network/indexer-auth.js';

const INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const HEADER = {name: 'X-Pool-Exemption', value: 'abc.123'};

afterEach(() => {
  __resetIndexerAuthForTests();
});

describe('parseAuthHeader', () => {
  it('accepts "Name: value" and "Name=value", trimming both sides', () => {
    expect(parseAuthHeader('X-Pool-Exemption: abc.123')).toEqual(HEADER);
    expect(parseAuthHeader('  X-Pool-Exemption=abc.123 ')).toEqual(HEADER);
    // A colon inside the value belongs to the value.
    expect(parseAuthHeader('Authorization: Bearer a:b')).toEqual({name: 'Authorization', value: 'Bearer a:b'});
  });

  it('rejects malformed input rather than sending something half-parsed', () => {
    for (const bad of [undefined, null, '', 'novalue', ': value', 'Bad Name: v', 'X: with\r\nnewline', 'X:   ']) {
      expect(parseAuthHeader(bad as string)).toBeUndefined();
    }
  });
});

describe('withIndexerAuth (fetch)', () => {
  it('adds the header only for requests to the indexer origin', async () => {
    await installIndexerAuthHeader(INDEXER, HEADER);
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(init?.headers ? Object.fromEntries(new Headers(init.headers)) : {})));
    const fetch = withIndexerAuth(base as unknown as typeof globalThis.fetch);

    await fetch('https://indexer.preprod.midnight.network/api/v4/graphql', {method: 'POST', headers: {'content-type': 'application/json'}});
    const sentToIndexer = new Headers((base.mock.calls[0]![1] as RequestInit).headers);
    expect(sentToIndexer.get('x-pool-exemption')).toBe('abc.123');
    expect(sentToIndexer.get('content-type')).toBe('application/json');

    await fetch('https://rpc.preprod.midnight.network/', {method: 'POST'});
    expect(new Headers((base.mock.calls[1]![1] as RequestInit | undefined)?.headers).get('x-pool-exemption')).toBeNull();

    // Same host, other path: still the indexer's origin.
    await fetch(new URL('https://indexer.preprod.midnight.network/api/v4/graphql/ws'));
    expect(new Headers((base.mock.calls[2]![1] as RequestInit).headers).get('x-pool-exemption')).toBe('abc.123');
  });

  it('keeps headers already on a Request object', async () => {
    await installIndexerAuthHeader(INDEXER, HEADER);
    const base = vi.fn(async () => new Response(''));
    const fetch = withIndexerAuth(base as unknown as typeof globalThis.fetch);
    await fetch(new Request(INDEXER, {headers: {accept: 'application/json'}}));
    const sent = new Headers((base.mock.calls[0]![1] as RequestInit).headers);
    expect(sent.get('accept')).toBe('application/json');
    expect(sent.get('x-pool-exemption')).toBe('abc.123');
  });
});

describe('withIndexerAuthWebSocket', () => {
  class FakeWs {
    constructor(
      public url: string | URL,
      public protocols?: string | string[],
      public options?: {headers?: Record<string, string>},
    ) {}
  }

  it('passes the header in the handshake options for the indexer origin only', async () => {
    await installIndexerAuthHeader(INDEXER, HEADER);
    const Authed = withIndexerAuthWebSocket(FakeWs);
    const toIndexer = new Authed('wss://indexer.preprod.midnight.network/api/v4/graphql/ws', 'graphql-transport-ws', {headers: {origin: 'x'}});
    expect(toIndexer.options).toEqual({headers: {origin: 'x', 'X-Pool-Exemption': 'abc.123'}});
    expect(toIndexer.protocols).toBe('graphql-transport-ws');

    const toNode = new Authed('wss://rpc.preprod.midnight.network/', undefined, undefined);
    expect(toNode.options).toBeUndefined();
  });
});

describe('installIndexerAuthHeader', () => {
  it('replaces the header for an origin and removes it on undefined', async () => {
    await installIndexerAuthHeader(INDEXER, HEADER);
    expect(hasIndexerAuthHeader()).toBe(true);
    await installIndexerAuthHeader(INDEXER, {name: 'X-Other', value: 'v'});
    const base = vi.fn(async () => new Response(''));
    await withIndexerAuth(base as unknown as typeof globalThis.fetch)(INDEXER);
    const sent = new Headers((base.mock.calls[0]![1] as RequestInit).headers);
    expect(sent.get('x-other')).toBe('v');
    expect(sent.get('x-pool-exemption')).toBeNull();

    await installIndexerAuthHeader(INDEXER, undefined);
    expect(hasIndexerAuthHeader()).toBe(false);
  });

  it('wraps the global fetch once and installs a ws-based WebSocket in Node', async () => {
    const before = globalThis.fetch;
    await installIndexerAuthHeader(INDEXER, HEADER);
    expect(globalThis.fetch).not.toBe(before);
    const wrapped = globalThis.fetch;
    await installIndexerAuthHeader('https://indexer.preview.midnight.network/api/v4/graphql', HEADER);
    expect(globalThis.fetch).toBe(wrapped);
    const impl = indexerWebSocketImpl();
    expect(impl).toBeDefined();
    expect((globalThis as {WebSocket?: unknown}).WebSocket).toBe(impl);
    __resetIndexerAuthForTests();
    expect(globalThis.fetch).toBe(before);
  });

  it('does nothing for an unusable url', async () => {
    await installIndexerAuthHeader('not a url', HEADER);
    expect(hasIndexerAuthHeader()).toBe(false);
  });
});

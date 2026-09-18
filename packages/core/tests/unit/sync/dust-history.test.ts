import {describe, expect, it, vi, afterEach} from 'vitest';
import {
  classifyDustGenerationsMessage,
  dustHistoryBefore,
  probeDustGenerations,
  type SocketLike,
} from '../../../src/sync/dust-history.js';
import type {IndexerClient} from '../../../src/network/indexer-client.js';

// A scriptable stand-in for the indexer's WebSocket: the test plays the server.
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(
    public url: string,
    public protocol: string,
  ) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
  /** Server side: open, ack, and hand back the subscribe frame the client sent. */
  handshake() {
    this.onopen?.({});
    this.onmessage?.({data: JSON.stringify({type: 'connection_ack'})});
    return this.sent.find((m) => m.type === 'subscribe') as {payload: {variables: {address: string; end: number}}};
  }
  next(dustGenerations: Record<string, unknown>) {
    this.onmessage?.({data: JSON.stringify({type: 'next', id: '1', payload: {data: {dustGenerations}}})});
  }
  complete() {
    this.onmessage?.({data: JSON.stringify({type: 'complete', id: '1'})});
  }
}

const socket = (url: string, protocol: string) => new FakeSocket(url, protocol);
const INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const ADDRESS = 'mn_dust_preprod1w0fju9wm5sgrwa6g7a65z39gazn82jpmf55dx66de3gykv6eygvxw6j8a6w';

afterEach(() => {
  FakeSocket.all = [];
  vi.useRealTimers();
});

describe('probeDustGenerations', () => {
  it('subscribes to the inclusive range below the reference tree size, on the indexer ws endpoint', async () => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 392_576, {socket});
    const sock = FakeSocket.all[0]!;
    const subscribe = sock.handshake();

    expect(sock.url).toBe('wss://indexer.preprod.midnight.network/api/v4/graphql/ws');
    expect(sock.protocol).toBe('graphql-transport-ws');
    expect(subscribe.payload.variables).toEqual({address: ADDRESS, end: 392_575});

    sock.complete();
    await pending;
  });

  // The preprod sequence for an address with no history: one progress frame, then
  // complete. The `complete` is the answer — silence alone never is.
  it('reports none when the bounded range completes without an owned entry', async () => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 392_576, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.next({__typename: 'DustGenerationsProgress', highestIndex: 392_575});
    sock.complete();

    await expect(pending).resolves.toEqual({kind: 'none'});
    expect(sock.closed).toBe(true);
  });

  it('reports some on the first owned entry, without waiting for the rest', async () => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 392_576, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.next({__typename: 'DustGenerationsItem', generationMtIndex: 1234});

    await expect(pending).resolves.toEqual({kind: 'some', entries: 1});
    expect(sock.closed).toBe(true);
  });

  it('treats a dtime update for an owned entry as history too', async () => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 10, {socket});
    FakeSocket.all[0]!.handshake();
    FakeSocket.all[0]!.next({__typename: 'DustGenerationDtimeUpdateItem', generationMtIndex: 3});

    await expect(pending).resolves.toEqual({kind: 'some', entries: 1});
  });

  it('is unknown when the indexer rejects the subscription', async () => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 10, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({data: JSON.stringify({type: 'error', id: '1', payload: [{message: 'Unknown field'}]})});

    const verdict = await pending;
    expect(verdict.kind).toBe('unknown');
    expect(verdict.kind === 'unknown' && verdict.reason).toMatch(/rejected/);
  });

  it('is unknown, never none, when the indexer goes quiet', async () => {
    vi.useFakeTimers();
    const pending = probeDustGenerations(INDEXER, ADDRESS, 10, {socket, timeoutMs: 5_000});
    FakeSocket.all[0]!.handshake();
    FakeSocket.all[0]!.next({__typename: 'DustGenerationsProgress', highestIndex: 9}); // progress, but no complete

    vi.advanceTimersByTime(5_000);

    const verdict = await pending;
    expect(verdict.kind).toBe('unknown');
    expect(FakeSocket.all[0]!.closed).toBe(true);
  });

  it('is unknown when the socket errors', async () => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 10, {socket});
    FakeSocket.all[0]!.onerror?.({});

    expect((await pending).kind).toBe('unknown');
  });

  it('answers none for an empty generation tree without opening a socket', async () => {
    await expect(probeDustGenerations(INDEXER, ADDRESS, 0, {socket})).resolves.toEqual({kind: 'none'});
    expect(FakeSocket.all).toHaveLength(0);
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid tree size %s without opening a socket', async (size) => {
    vi.useFakeTimers();
    const pending = probeDustGenerations(INDEXER, ADDRESS, size, {socket});
    await vi.runAllTimersAsync();
    expect((await pending).kind).toBe('unknown');
    expect(FakeSocket.all).toHaveLength(0);
  });

  it.each([
    'not json',
    'null',
    JSON.stringify({type: 'next', id: '1', payload: {data: null}}),
    JSON.stringify({type: 'next', id: '1', payload: {data: {dustGenerations: {__typename: 'NewHistoryItem'}}}}),
  ])('does not turn unreadable history into an empty result: %s', async (frame) => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 10, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({data: frame});
    sock.complete();
    expect((await pending).kind).toBe('unknown');
  });

  it('does not accept completion for another subscription', async () => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 10, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({data: JSON.stringify({type: 'complete', id: 'other'})});
    expect((await pending).kind).toBe('unknown');
  });

  it('does not accept completion before subscribing', async () => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 10, {socket});
    FakeSocket.all[0]!.complete();
    expect((await pending).kind).toBe('unknown');
  });

  it('answers keepalive pings', async () => {
    const pending = probeDustGenerations(INDEXER, ADDRESS, 10, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({data: JSON.stringify({type: 'ping'})});
    expect(sock.sent.at(-1)).toEqual({type: 'pong'});
    sock.complete();
    await pending;
  });
});

describe('dustHistoryBefore', () => {
  const indexer = (size: number | null) =>
    ({getDustGenerationEndIndex: vi.fn(async () => size)}) as unknown as IndexerClient;

  it('sizes the range from the generation tree at the reference height', async () => {
    const client = indexer(392_576);
    const pending = dustHistoryBefore(client, INDEXER, ADDRESS, 2_203_416, {socket});
    await Promise.resolve();
    const subscribe = FakeSocket.all[0]!.handshake();

    expect(client.getDustGenerationEndIndex).toHaveBeenCalledWith(2_203_416);
    expect(subscribe.payload.variables.end).toBe(392_575);
    FakeSocket.all[0]!.complete();
    await expect(pending).resolves.toEqual({kind: 'none'});
  });

  it('fails closed when the indexer cannot report the tree size', async () => {
    const verdict = await dustHistoryBefore(indexer(null), INDEXER, ADDRESS, 2_203_416, {socket});

    expect(verdict.kind).toBe('unknown');
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe('classifyDustGenerationsMessage', () => {
  it('surfaces GraphQL errors carried inside a next frame', () => {
    const frame = JSON.stringify({type: 'next', id: '1', payload: {data: null, errors: [{message: 'startIndex is required'}]}});
    expect(classifyDustGenerationsMessage(frame).kind).toBe('error');
  });

  it('rejects history frames it does not understand', () => {
    expect(classifyDustGenerationsMessage('not json').kind).toBe('error');
    expect(classifyDustGenerationsMessage(JSON.stringify({type: 'next', id: '1', payload: {data: {dustGenerations: {__typename: 'Something'}}}})).kind).toBe('error');
  });
});

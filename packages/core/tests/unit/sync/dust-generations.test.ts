import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  dustGenerationsQuery,
  fetchDustGenerations,
  parseDustGenerationsFrame,
  readDustTip,
  type SocketLike,
} from '../../../src/sync/dust-generations.js';

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
  handshake() {
    this.onopen?.({});
    this.onmessage?.({data: JSON.stringify({type: 'connection_ack'})});
    return this.sent.find((m) => m.type === 'subscribe') as {payload: {query: string; variables?: unknown}};
  }
  next(data: Record<string, unknown>) {
    this.onmessage?.({data: JSON.stringify({type: 'next', id: '1', payload: {data}})});
  }
  complete() {
    this.onmessage?.({data: JSON.stringify({type: 'complete', id: '1'})});
  }
}

const socket = (url: string, protocol: string) => new FakeSocket(url, protocol);
const INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const ADDRESS = 'mn_dust_preprod1w0c04d5s2zc3xjsxdx8l3aekjagjan2lwplhgqnv9edw99rvazvq65er7r8';

const ITEM_990 = {
  __typename: 'DustGenerationsItem',
  commitmentMtIndex: 1_150_020,
  generationMtIndex: 397_204,
  value: '990000000',
  initialValue: '0',
  backingNight: '1e0d0fc0fa2c3a6be677e1a88e0e6463bfbd92f666608a65d6d87c8a955a8724',
  ctime: 1_790_026_134,
  transactionHash: '4504f1c43081',
};
const ITEM_10 = {...ITEM_990, commitmentMtIndex: 1_150_019, generationMtIndex: 397_203, value: '10000000', backingNight: '0ff2f705'};

afterEach(() => {
  FakeSocket.all = [];
  vi.useRealTimers();
});

describe('dustGenerationsQuery', () => {
  it('inlines the address and the inclusive end index', () => {
    const q = dustGenerationsQuery(ADDRESS, 397_300);
    expect(q).toContain(`dustAddress: "${ADDRESS}"`);
    expect(q).toContain('startIndex: 0, endIndex: 397299');
    expect(q).not.toContain('$');
  });
});

describe('parseDustGenerationsFrame', () => {
  it('turns an item into an entry with STAR, SPECK and ms units', () => {
    const f = parseDustGenerationsFrame(JSON.stringify({type: 'next', payload: {data: {dustGenerations: ITEM_990}}}));
    expect(f.kind).toBe('item');
    if (f.kind !== 'item') return;
    expect(f.entry).toEqual({
      generationMtIndex: 397_204,
      commitmentMtIndex: 1_150_020,
      night: 990_000_000n,
      initialValue: 0n,
      ctimeMs: 1_790_026_134_000,
      backingNight: ITEM_990.backingNight,
      transactionHash: '4504f1c43081',
      dtimeMs: null,
    });
  });

  it('classifies the other frames', () => {
    expect(parseDustGenerationsFrame(JSON.stringify({type: 'connection_ack'}))).toEqual({kind: 'ack'});
    expect(parseDustGenerationsFrame(JSON.stringify({type: 'ping'}))).toEqual({kind: 'ping'});
    expect(parseDustGenerationsFrame(JSON.stringify({type: 'complete'}))).toEqual({kind: 'complete'});
    expect(
      parseDustGenerationsFrame(
        JSON.stringify({type: 'next', payload: {data: {dustGenerations: {__typename: 'DustGenerationDtimeUpdateItem', generationMtIndex: 5, newDtime: 100}}}}),
      ),
    ).toEqual({kind: 'dtime', generationMtIndex: 5, dtimeMs: 100_000});
    expect(
      parseDustGenerationsFrame(JSON.stringify({type: 'next', payload: {data: {dustGenerations: {__typename: 'DustGenerationsProgress', highestIndex: 9}}}})),
    ).toEqual({kind: 'progress', highestIndex: 9});
    expect(parseDustGenerationsFrame(JSON.stringify({type: 'error', payload: [{message: 'bad'}]}))).toEqual({kind: 'error', detail: '[{"message":"bad"}]'});
    expect(parseDustGenerationsFrame('not json')).toEqual({kind: 'other'});
  });

  it('treats a payload with errors as an error, not data', () => {
    const f = parseDustGenerationsFrame(JSON.stringify({type: 'next', payload: {errors: [{message: 'Invalid value for argument "endIndex"'}]}}));
    expect(f.kind).toBe('error');
  });
});

describe('fetchDustGenerations', () => {
  it('subscribes with inlined integers and folds dtime updates into the entries', async () => {
    const pending = fetchDustGenerations(INDEXER, ADDRESS, 397_300, {socket});
    const sock = FakeSocket.all[0]!;
    const subscribe = sock.handshake();
    expect(sock.url).toBe('wss://indexer.preprod.midnight.network/api/v4/graphql/ws');
    expect(subscribe.payload.variables).toBeUndefined();
    expect(subscribe.payload.query).toContain('endIndex: 397299');

    sock.next({dustGenerations: ITEM_990});
    sock.next({dustGenerations: ITEM_10});
    sock.next({dustGenerations: {__typename: 'DustGenerationDtimeUpdateItem', generationMtIndex: 397_203, newDtime: 1_790_100_000}});
    sock.next({dustGenerations: {__typename: 'DustGenerationsProgress', highestIndex: 397_299}});
    sock.complete();

    const result = await pending;
    expect(result.endedBy).toBe('complete');
    expect(result.entries.map((e) => e.generationMtIndex)).toEqual([397_203, 397_204]);
    expect(result.entries[0]!.dtimeMs).toBe(1_790_100_000_000);
    expect(result.live.map((e) => e.generationMtIndex)).toEqual([397_204]);
    expect(sock.closed).toBe(true);
  });

  it('accepts silence after the last frame as the end of the stream', async () => {
    vi.useFakeTimers();
    const pending = fetchDustGenerations(INDEXER, ADDRESS, 10, {socket, quietMs: 1_000});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.next({dustGenerations: ITEM_990});
    vi.advanceTimersByTime(1_000);
    const result = await pending;
    expect(result.endedBy).toBe('quiet');
    expect(result.live).toHaveLength(1);
  });

  it('does not take silence before any frame as an empty answer', async () => {
    vi.useFakeTimers();
    const pending = fetchDustGenerations(INDEXER, ADDRESS, 10, {socket, quietMs: 1_000, timeoutMs: 5_000});
    FakeSocket.all[0]!.handshake();
    vi.advanceTimersByTime(4_999);
    // Not settled yet: the quiet timer only arms after a frame.
    let settled = false;
    void pending.then(() => (settled = true), () => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(pending).rejects.toThrow(/no answer/);
  });

  it('rejects when the indexer rejects the subscription', async () => {
    const pending = fetchDustGenerations(INDEXER, ADDRESS, 10, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({data: JSON.stringify({type: 'error', id: '1', payload: [{message: 'Unknown field'}]})});
    await expect(pending).rejects.toThrow(/rejected/);
    expect(sock.closed).toBe(true);
  });

  it('answers pings and resolves an empty range without asking the indexer', async () => {
    await expect(fetchDustGenerations(INDEXER, ADDRESS, 0, {socket})).resolves.toEqual({entries: [], live: [], endedBy: 'complete'});
    expect(FakeSocket.all).toHaveLength(0);

    const pending = fetchDustGenerations(INDEXER, ADDRESS, 10, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({data: JSON.stringify({type: 'ping'})});
    expect(sock.sent.some((m) => m.type === 'pong')).toBe(true);
    sock.complete();
    await pending;
  });
});

describe('readDustTip', () => {
  it('returns the first event id and the indexer maxId from one frame', async () => {
    const pending = readDustTip(INDEXER, 1_549_223, {socket});
    const sock = FakeSocket.all[0]!;
    const subscribe = sock.handshake();
    expect(subscribe.payload.query).toContain('dustLedgerEvents(id: 1549223)');
    sock.next({dustLedgerEvents: {id: 1_549_223, maxId: 1_549_339}});
    await expect(pending).resolves.toEqual({id: 1_549_223, maxId: 1_549_339});
    expect(sock.closed).toBe(true);
  });

  it('resolves null when the stream completes or stays silent', async () => {
    const pending = readDustTip(INDEXER, 5, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.complete();
    await expect(pending).resolves.toBeNull();

    vi.useFakeTimers();
    const quiet = readDustTip(INDEXER, 5, {socket, timeoutMs: 1_000});
    FakeSocket.all[1]!.handshake();
    vi.advanceTimersByTime(1_000);
    await expect(quiet).resolves.toBeNull();
  });

  it('rejects on an indexer error', async () => {
    const pending = readDustTip(INDEXER, 5, {socket});
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({data: JSON.stringify({type: 'error', id: '1', payload: [{message: 'nope'}]})});
    await expect(pending).rejects.toThrow(/rejected/);
  });
});

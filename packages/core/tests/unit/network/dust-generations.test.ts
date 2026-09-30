import { afterEach, describe, expect, it, vi } from 'vitest';
import { dustGenerationsFor, type SocketLike } from '../../../src/network/dust-generations.js';

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
    this.onmessage?.({ data: JSON.stringify({ type: 'connection_ack' }) });
    return this.sent.find((m) => m.type === 'subscribe') as {
      payload: { variables: { address: string; from: number; to: number } };
    };
  }
  next(dustGenerations: Record<string, unknown>) {
    this.onmessage?.({
      data: JSON.stringify({ type: 'next', id: '1', payload: { data: { dustGenerations } } }),
    });
  }
  complete() {
    this.onmessage?.({ data: JSON.stringify({ type: 'complete', id: '1' }) });
  }
}

const socket = (url: string, protocol: string) => new FakeSocket(url, protocol);
const INDEXER = 'https://indexer.preprod.midnight.network/api/v4/graphql';
const ADDRESS = 'mn_dust_preprod1w0fju9wm5sgrwa6g7a65z39gazn82jpmf55dx66de3gykv6eygvxw6j8a6w';

const ENTRY = {
  __typename: 'DustGenerationsItem',
  generationMtIndex: 338_505,
  commitmentMtIndex: 12,
  value: '4200',
  initialValue: '5000',
  ctime: 1_770_000_000,
  backingNight: 'night-utxo-hash',
  transactionHash: 'tx-hash',
};

afterEach(() => {
  FakeSocket.all = [];
  vi.useRealTimers();
});

describe('dustGenerationsFor', () => {
  it('subscribes on the indexer ws endpoint, over the bound it was given', async () => {
    const pending = dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: 392_598 });
    const sock = FakeSocket.all[0]!;
    const subscribe = sock.handshake();

    expect(sock.url).toBe('wss://indexer.preprod.midnight.network/api/v4/graphql/ws');
    expect(sock.protocol).toBe('graphql-transport-ws');
    expect(subscribe.payload.variables).toEqual({ address: ADDRESS, from: 0, to: 392_598 });

    sock.complete();
    await pending;
  });

  it('collects entries and ends on complete, not on a quiet gap', async () => {
    const pending = dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: 392_598 });
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.next(ENTRY);
    sock.next({ ...ENTRY, generationMtIndex: 338_506, value: '100' });
    sock.complete();

    const result = await pending;
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.generationMtIndex).toBe(338_505);
    expect(result.entries[0]!.value).toBe('4200');
    expect(result.truncated).toBe(false);
    expect(sock.closed).toBe(true);
  });

  // The bug this command had: a bounded range that finds nothing must be
  // reported as nothing, and it must be distinguishable from giving up.
  it('reports an empty result as complete, not truncated', async () => {
    const pending = dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: 392_598 });
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.next({ __typename: 'DustGenerationsProgress', highestIndex: 392_598 });
    sock.complete();

    const result = await pending;
    expect(result).toMatchObject({ entries: [], dtimeUpdates: 0, highestIndex: 392_598, truncated: false });
  });

  it('counts dtime updates separately from entries', async () => {
    const pending = dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: 10 });
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.next({ __typename: 'DustGenerationDtimeUpdateItem', generationMtIndex: 3 });
    sock.complete();

    const result = await pending;
    expect(result).toMatchObject({ entries: [], dtimeUpdates: 1, truncated: false });
  });

  // The trap: the indexer delivers a rejected subscription as a `next` frame
  // carrying `errors`, not as the protocol's `error` type. Swallowing it is how
  // "no DUST generation" got reported confidently for a query that never ran.
  it('rejects on a GraphQL error carried inside a next frame', async () => {
    const pending = dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: 10 });
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({
      data: JSON.stringify({
        type: 'next',
        id: '1',
        payload: { data: null, errors: [{ message: 'endIndex is required' }] },
      }),
    });

    await expect(pending).rejects.toThrow(/endIndex is required/);
    expect(sock.closed).toBe(true);
  });

  it('rejects on the protocol error type too', async () => {
    const pending = dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: 10 });
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({ data: JSON.stringify({ type: 'error', id: '1', payload: [{ message: 'nope' }] }) });

    await expect(pending).rejects.toThrow(/rejected the subscription/);
  });

  it('marks a run that stopped on the time budget as truncated', async () => {
    vi.useFakeTimers();
    const pending = dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: 10, timeoutMs: 5_000 });
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.next(ENTRY);

    vi.advanceTimersByTime(5_000);

    const result = await pending;
    expect(result.entries).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(sock.closed).toBe(true);
  });

  it('answers keepalive pings', async () => {
    const pending = dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: 10 });
    const sock = FakeSocket.all[0]!;
    sock.handshake();
    sock.onmessage?.({ data: JSON.stringify({ type: 'ping' }) });

    expect(sock.sent.at(-1)).toEqual({ type: 'pong' });
    sock.complete();
    await pending;
  });

  it('rejects when the socket errors', async () => {
    const pending = dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: 10 });
    FakeSocket.all[0]!.onerror?.({});

    await expect(pending).rejects.toThrow(/Could not reach/);
  });

  it('answers an empty tree without opening a socket', async () => {
    const result = await dustGenerationsFor(INDEXER, ADDRESS, { socket, endIndex: -1 });

    expect(result).toEqual({ entries: [], dtimeUpdates: 0, highestIndex: null, truncated: false });
    expect(FakeSocket.all).toHaveLength(0);
  });
});

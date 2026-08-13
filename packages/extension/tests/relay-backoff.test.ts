import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  backoffDelayMs,
  classifyProbe,
  installRelayBackoff,
  setRelayUrl,
  relayRetry,
  relayState,
} from '../lib/offscreen/relay-socket';

// A fixed "random" of 0.5 lands the jitter factor exactly on 1.0, so the curve
// can be asserted on its nominal values.
const noJitter = () => 0.5;

describe('backoffDelayMs', () => {
  it('starts at WsProvider’s own 2.5s so a one-off blip recovers as fast as before', () => {
    expect(backoffDelayMs(1, noJitter)).toBe(2_500);
  });

  it('doubles each consecutive failure', () => {
    expect(backoffDelayMs(2, noJitter)).toBe(5_000);
    expect(backoffDelayMs(3, noJitter)).toBe(10_000);
    expect(backoffDelayMs(4, noJitter)).toBe(20_000);
    expect(backoffDelayMs(5, noJitter)).toBe(40_000);
  });

  it('flattens at one attempt a minute instead of growing without bound', () => {
    expect(backoffDelayMs(6, noJitter)).toBe(60_000);
    expect(backoffDelayMs(20, noJitter)).toBe(60_000);
    // The exponent would overflow to Infinity long before this without the cap.
    expect(backoffDelayMs(2_000, noJitter)).toBe(60_000);
  });

  it('never returns a delay for a wallet that has not failed', () => {
    expect(backoffDelayMs(0, noJitter)).toBe(0);
    expect(backoffDelayMs(-1, noJitter)).toBe(0);
  });

  it('spreads attempts ±20% so wallets against one endpoint do not resynchronise', () => {
    expect(backoffDelayMs(6, () => 0)).toBe(48_000);
    expect(backoffDelayMs(6, () => 0.999_999)).toBeLessThanOrEqual(72_000);
    expect(backoffDelayMs(6, () => 0.999_999)).toBeGreaterThan(71_000);
  });

  it('keeps every jittered delay inside the cap’s ±20% band', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
        const delay = backoffDelayMs(attempt, () => random);
        expect(delay).toBeGreaterThanOrEqual(2_000); // 2.5s - 20%
        expect(delay).toBeLessThanOrEqual(72_000); // 60s + 20%
      }
    }
  });

  it('is monotonic up to the cap', () => {
    const delays = [1, 2, 3, 4, 5, 6].map((attempt) => backoffDelayMs(attempt, noJitter));
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    }
  });
});

describe('classifyProbe', () => {
  it('calls an explicit refusal what it is, so the copy can stop blaming the network', () => {
    expect(classifyProbe(403)).toBe('forbidden');
    expect(classifyProbe(401)).toBe('forbidden');
  });

  it('treats 405 as PROOF THE ENDPOINT IS UP, not as an outage', () => {
    // 405 is what a healthy node answers to a plain GET on its WS endpoint. It
    // once mapped to `unreachable`, so the banner said "Can't reach the node"
    // while displaying "HTTP 405" — the evidence against itself — on every
    // wallet open and network switch, on healthy networks.
    expect(classifyProbe(405)).toBe('reachable');
  });

  it('treats any HTTP answer as reachable — something is listening', () => {
    // The probe exists to separate "endpoint down" from "that socket failed".
    // A response of any kind settles the first question.
    expect(classifyProbe(200)).toBe('reachable');
    expect(classifyProbe(404)).toBe('reachable');
    expect(classifyProbe(500)).toBe('reachable');
    expect(classifyProbe(502)).toBe('reachable');
  });

  it('reserves unreachable for no answer at all', () => {
    // DNS failure, TLS failure, offline: fetch could not complete.
    expect(classifyProbe(null)).toBe('unreachable');
  });
});

// The whole mechanism hinges on RECOGNISING the relay socket. Core builds the
// SDK's relay URL as `new URL(toWsUrl(nodeUrl))`, which normalises
// "https://rpc.preprod.midnight.network" to "wss://rpc.preprod.midnight.network/"
// — WITH a trailing slash. A caller mirroring that with a plain string replace
// stores it WITHOUT one. When those failed to compare equal every relay socket
// was passed straight through and the backoff did nothing at all, silently,
// while looking installed.
//
// Recognition is only observable through behaviour: a recognised endpoint enters
// a backoff window after a failure, and the NEXT construction gets a stub that
// touches no network. An unrecognised one dials for real every time. So these
// tests count real dials rather than asserting on internals.
describe('relay URL matching', () => {
  const realDials: string[] = [];

  class FakeSocket {
    url: string;
    private readonly listeners = new Map<string, Set<(e: unknown) => void>>();
    constructor(url: string | URL) {
      this.url = String(url);
      realDials.push(this.url);
    }
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    }
    removeEventListener(type: string, fn: (e: unknown) => void) {
      this.listeners.get(type)?.delete(fn);
    }
    /** Drive the failure path the wrapper listens for. */
    fail() {
      for (const fn of this.listeners.get('error') ?? []) fn(new Event('error'));
      for (const fn of this.listeners.get('close') ?? []) fn(new Event('close'));
    }
    close() {}
    send() {}
  }

  const constructed: FakeSocket[] = [];
  class TrackingSocket extends FakeSocket {
    constructor(url: string | URL, _protocols?: string | string[]) {
      super(url);
      constructed.push(this);
    }
  }

  beforeEach(() => {
    realDials.length = 0;
    constructed.length = 0;
    // fetch is used by the classification probe; keep the suite off the network.
    vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }));
    vi.stubGlobal('WebSocket', TrackingSocket as unknown as typeof WebSocket);
    installRelayBackoff();
  });

  afterEach(() => {
    relayRetry();
    setRelayUrl('wss://reset.invalid/');
    vi.unstubAllGlobals();
  });

  it('recognises the SDK dial form when configured from the slash-less form', () => {
    // What wallet-host derives from network.nodeUrl by string replace...
    setRelayUrl('wss://rpc.preprod.midnight.network');
    const Wrapped = globalThis.WebSocket;

    // ...against what WsProvider actually dials, via core's `new URL(...)`.
    new Wrapped('wss://rpc.preprod.midnight.network/');
    expect(realDials).toHaveLength(1);

    // Fail it: a RECOGNISED endpoint now opens a backoff window.
    constructed[0]!.fail();

    // The next construction must be a stub — no second dial reaches the wire.
    new Wrapped('wss://rpc.preprod.midnight.network/');
    expect(realDials).toHaveLength(1);
  });

  it('never throttles a different socket, however similar', () => {
    setRelayUrl('wss://rpc.preprod.midnight.network');
    const Wrapped = globalThis.WebSocket;

    // The indexer's socket must always dial: throttling it would stall sync.
    const indexer = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';
    new Wrapped(indexer);
    constructed[0]!.fail();
    new Wrapped(indexer);

    expect(realDials).toEqual([indexer, indexer]);
  });
});

// The bug this guards: opening the wallet or switching networks showed
// "Can't reach the node · HTTP 405 · 1 attempt" on HEALTHY networks. One
// transient socket failure at startup set status = 'unreachable', and the probe
// that came back proving the endpoint was up only labelled the state — it never
// withdrew it.
describe('reporting an outage', () => {
  const dials: string[] = [];
  let probeStatus = 405;

  class Sock {
    private readonly listeners = new Map<string, Set<(e: unknown) => void>>();
    constructor(url: string | URL) {
      dials.push(String(url));
    }
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    }
    removeEventListener() {}
    fail() {
      for (const fn of this.listeners.get('error') ?? []) fn(new Event('error'));
    }
    close() {}
    send() {}
  }
  const made: Sock[] = [];
  class Tracked extends Sock {
    constructor(url: string | URL, _p?: string | string[]) {
      super(url);
      made.push(this);
    }
  }

  const RELAY = 'wss://rpc.preview.midnight.network/';

  beforeEach(() => {
    dials.length = 0;
    made.length = 0;
    vi.stubGlobal('fetch', async () => new Response(null, { status: probeStatus }));
    vi.stubGlobal('WebSocket', Tracked as unknown as typeof WebSocket);
    installRelayBackoff();
    relayRetry();
    setRelayUrl(RELAY);
  });

  afterEach(() => {
    relayRetry();
    setRelayUrl('wss://reset.invalid/');
    vi.unstubAllGlobals();
  });

  it('does not report an outage after a single failure', async () => {
    probeStatus = 405;
    new (globalThis.WebSocket as unknown as typeof Tracked)(RELAY);
    made[0]!.fail();

    // Backoff has engaged — but the user is told nothing yet, because one failed
    // socket during startup is ordinary.
    expect(relayState().attempts).toBe(1);
    expect(relayState().status).not.toBe('unreachable');
  });

  it('withdraws the outage when the probe proves the endpoint answers', async () => {
    probeStatus = 405;
    const Wrapped = globalThis.WebSocket as unknown as typeof Tracked;
    for (let i = 0; i < 3; i++) {
      new Wrapped(RELAY);
      made[made.length - 1]!.fail();
    }
    // Crossing the threshold reports it...
    expect(relayState().attempts).toBe(3);

    // ...and the forced probe at that boundary answers 405, which means the
    // endpoint is up. The outage must be withdrawn, not annotated.
    await new Promise((r) => setTimeout(r, 0));
    expect(relayState().reason).toBe('reachable');
    expect(relayState().status).not.toBe('unreachable');
  });

  it('reports a refusal immediately, without waiting for the threshold', async () => {
    probeStatus = 403;
    new (globalThis.WebSocket as unknown as typeof Tracked)(RELAY);
    made[0]!.fail();

    // The server answered and refused. There is nothing transient to wait out,
    // so one attempt is enough to tell the user.
    await new Promise((r) => setTimeout(r, 0));
    expect(relayState().reason).toBe('forbidden');
    expect(relayState().status).toBe('unreachable');
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  asCurl,
  createRequestMeter,
  installRequestMeter,
  MAX_BODY_CHARS,
  MAX_FAILURES,
  WINDOW_MS,
} from '../lib/offscreen/request-meter';

/** A clock we drive by hand, so rate arithmetic is tested without waiting. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('createRequestMeter', () => {
  it('groups by host, busiest first', () => {
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    for (let i = 0; i < 3; i++) m.record('https://indexer.example/api/v1/graphql');
    m.record('https://rpc.example/');
    const s = m.snapshot();
    expect(s.hosts.map((h) => h.host)).toEqual(['indexer.example', 'rpc.example']);
    expect(s.hosts[0]!.total).toBe(3);
    expect(s.totalInWindow).toBe(4);
  });

  it('reports the per-second rate over the last second only', () => {
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    for (let i = 0; i < 5; i++) m.record('https://rpc.example/');
    expect(m.snapshot().hosts[0]!.perSecond).toBe(5);
    c.advance(1_500);
    // Still inside the five-minute window, but no longer inside the last second.
    const s = m.snapshot();
    expect(s.hosts[0]!.perSecond).toBe(0);
    expect(s.hosts[0]!.total).toBe(5);
  });

  it('averages over the last minute, rounded to something quotable', () => {
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    // 50 requests, one per second. All 50 are still inside the trailing minute
    // at snapshot time, so the mean is 50/60 = 0.83/s.
    for (let i = 0; i < 50; i++) { m.record('https://rpc.example/'); c.advance(1_000); }
    expect(m.snapshot().hosts[0]!.perSecondAvg60).toBe(0.83);

    // Let them age past the minute and the mean falls away with them.
    c.advance(61_000);
    expect(m.snapshot().hosts[0]!.perSecondAvg60).toBe(0);
  });

  it('drops anything older than the window, so memory stays bounded', () => {
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    m.record('https://rpc.example/');
    c.advance(WINDOW_MS + 1);
    m.record('https://rpc.example/');
    const s = m.snapshot();
    expect(s.hosts[0]!.total).toBe(1);
    expect(s.totalInWindow).toBe(1);
  });

  it('keeps a host after its requests age out, with the window emptied', () => {
    // The page is opened minutes after the thing it is meant to explain. If a
    // quiet host vanished, a wallet that got two 403s and then went idle would
    // show nothing at all — which is exactly what happened.
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    const settle = m.record('https://gone.example/');
    settle(403);
    c.advance(WINDOW_MS + 1);
    const host = m.snapshot().hosts[0]!;
    expect(host.host).toBe('gone.example');
    expect(host.total).toBe(0); // nothing in the window
    expect(host.totalAllTime).toBe(1); // but it did happen
    expect(host.byStatus.forbidden).toBe(1); // and this is why you are here
    expect(host.perSecond).toBe(0);
  });

  it('reports how stale the figures are, at any age', () => {
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    m.record('https://rpc.example/');
    c.advance(WINDOW_MS * 3);
    // Not null just because it left the window — that number is what tells you
    // the counts above it are an hour old.
    expect(m.snapshot().hosts[0]!.sinceLastMs).toBe(WINDOW_MS * 3);
  });

  it('forgets everything only when explicitly reset', () => {
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    m.record('https://rpc.example/');
    m.reset();
    expect(m.snapshot().hosts).toEqual([]);
  });

  it('reports time since the last request, for spotting a stalled endpoint', () => {
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    m.record('https://rpc.example/');
    c.advance(4_000);
    expect(m.snapshot().hosts[0]!.sinceLastMs).toBe(4_000);
  });

  it('keeps an unparseable URL rather than dropping it', () => {
    // An endpoint odd enough not to parse is itself worth seeing in a report.
    const m = createRequestMeter(fakeClock().now);
    m.record('not-a-url');
    expect(m.snapshot().hosts[0]!.host).toBe('not-a-url');
  });
});

describe('installRequestMeter', () => {
  it('counts fetch calls without altering them', async () => {
    const m = createRequestMeter();
    const original = vi.fn(async () => new Response('ok'));
    const target = { fetch: original as unknown as typeof fetch, WebSocket: class {} as never };
    const uninstall = installRequestMeter(m, target);

    const res = await target.fetch('https://indexer.example/graphql');
    expect(await res.text()).toBe('ok');            // result passes through
    expect(original).toHaveBeenCalledOnce();         // original still called
    expect(m.snapshot().totalInWindow).toBe(1);

    uninstall();
    expect(target.fetch).toBe(original);
  });

  it('counts a Request object and a URL, not just strings', async () => {
    const m = createRequestMeter();
    const target = {
      fetch: (async () => new Response('')) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await target.fetch(new URL('https://a.example/x'));
    await target.fetch(new Request('https://b.example/y'));
    expect(m.snapshot().hosts.map((h) => h.host).sort()).toEqual(['a.example', 'b.example']);
  });

  it('counts WebSocket construction and still constructs one', () => {
    const m = createRequestMeter();
    const constructed: string[] = [];
    class FakeSocket {
      constructor(url: string) { constructed.push(url); }
    }
    const target = { fetch: (async () => new Response('')) as unknown as typeof fetch, WebSocket: FakeSocket as never };
    installRequestMeter(m, target);
    const sock = new (target.WebSocket as unknown as new (u: string) => object)('wss://rpc.example/');
    expect(sock).toBeInstanceOf(FakeSocket);
    expect(constructed).toEqual(['wss://rpc.example/']);
    expect(m.snapshot().hosts[0]!.host).toBe('rpc.example');
  });

  it('lets a fetch rejection through unchanged', async () => {
    // A diagnostic must never swallow or reshape an error in the thing it measures.
    const m = createRequestMeter();
    const boom = new Error('network down');
    const target = {
      fetch: (async () => { throw boom; }) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await expect(target.fetch('https://rpc.example/')).rejects.toBe(boom);
    expect(m.snapshot().totalInWindow).toBe(1);      // still counted
  });
});

// The 403 investigation is the point: a rate without outcomes says nothing about
// whether the endpoint is refusing you.
describe('status tracking', () => {
  it('separates 403 from other client errors, server errors and failures', async () => {
    const m = createRequestMeter();
    const statuses = [200, 403, 403, 404, 500];
    let i = 0;
    const target = {
      fetch: (async () => new Response('', { status: statuses[i++] })) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    for (const _ of statuses) await target.fetch('https://rpc.example/');

    const host = m.snapshot().hosts[0]!;
    expect(host.total).toBe(5);
    expect(host.byStatus).toEqual({ ok: 1, forbidden: 2, otherClientError: 1, serverError: 1, failed: 0 });
    expect(host.statusCounts['403']).toBe(2);
  });

  it('records a network failure distinctly from an HTTP error', async () => {
    const m = createRequestMeter();
    const target = {
      fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await expect(target.fetch('https://rpc.example/')).rejects.toThrow('offline');
    const host = m.snapshot().hosts[0]!;
    expect(host.byStatus.failed).toBe(1);
    expect(host.statusCounts['failed']).toBe(1);
  });

  it('counts an in-flight request in the rate but gives it no status', async () => {
    // A rate limiter counts the request when it is sent, so the total must
    // include it even though no outcome exists yet.
    const m = createRequestMeter();
    let release: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => { release = r; });
    const target = {
      fetch: (() => pending) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    const inFlight = target.fetch('https://rpc.example/');

    let host = m.snapshot().hosts[0]!;
    expect(host.total).toBe(1);
    expect(Object.values(host.byStatus).reduce((a, b) => a + b, 0)).toBe(0);

    release(new Response('', { status: 403 }));
    await inFlight;
    host = m.snapshot().hosts[0]!;
    expect(host.byStatus.forbidden).toBe(1);
  });
});

// The mean hides bursts, and a burst is what a rate limiter refuses. By the time
// anyone opens the debug page the burst is usually over, so the peak has to be
// retained rather than sampled.
describe('peak per second', () => {
  it('finds the busiest second even after it has passed', () => {
    const c = fakeClock();
    const m = createRequestMeter(c.now);

    // A burst of 40 inside one second...
    for (let i = 0; i < 40; i++) { m.record('https://rpc.example/'); c.advance(20); }
    // ...then two quiet minutes.
    c.advance(120_000);
    m.record('https://rpc.example/');

    const host = m.snapshot().hosts[0]!;
    expect(host.peakPerSecond).toBe(40);
    expect(host.perSecond).toBe(1);          // now: quiet
    expect(host.perSecondAvg60).toBeLessThan(1); // mean: looks harmless
  });

  it('reports when the peak happened, so it can be correlated', () => {
    const c = fakeClock(500_000);
    const m = createRequestMeter(c.now);
    c.advance(10_000);
    const burstStart = c.now();
    for (let i = 0; i < 5; i++) { m.record('https://rpc.example/'); c.advance(100); }
    expect(m.snapshot().hosts[0]!.peakAt).toBe(burstStart);
  });

  it('counts a second as a sliding window, not a fixed bucket', () => {
    // Five requests spanning 999ms are one second's worth wherever the boundary
    // falls; a fixed-bucket count would split them and report a smaller peak.
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    for (let i = 0; i < 5; i++) { m.record('https://rpc.example/'); c.advance(249); }
    expect(m.snapshot().hosts[0]!.peakPerSecond).toBe(5);
  });

  it('is zero with nothing recorded', () => {
    const m = createRequestMeter(fakeClock().now);
    expect(m.snapshot().hosts).toEqual([]);
  });

  it('keeps the peak after the burst ages out of the window', () => {
    // The burst IS the finding. It is over by the time anyone looks, so a peak
    // that expired with its entries would never once be read.
    const c = fakeClock();
    const m = createRequestMeter(c.now);
    for (let i = 0; i < 30; i++) m.record('https://rpc.example/');
    c.advance(WINDOW_MS + 1);
    m.record('https://rpc.example/');
    const host = m.snapshot().hosts[0]!;
    expect(host.peakPerSecond).toBe(30);
    expect(host.total).toBe(1); // the window itself has moved on
  });
});

// Eight of ten rpc requests showed no outcome at all, because they were sockets
// and a socket has no HTTP status. That is the gap these cover.
describe('WebSocket outcomes', () => {
  class FakeSocket {
    private listeners: Record<string, ((e: unknown) => void)[]> = {};
    constructor(public url: string) {}
    addEventListener(type: string, fn: (e: unknown) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type: string, e?: unknown) {
      for (const fn of this.listeners[type] ?? []) fn(e);
    }
  }

  const wire = () => {
    const m = createRequestMeter();
    const target = {
      fetch: (async () => new Response('')) as unknown as typeof fetch,
      WebSocket: FakeSocket as never,
    };
    installRequestMeter(m, target);
    const make = (u: string) =>
      new (target.WebSocket as unknown as new (u: string) => FakeSocket)(u);
    return { m, make };
  };

  it('separates a socket that opened from one that never did', () => {
    const { m, make } = wire();
    make('wss://rpc.example/').emit('open');
    make('wss://rpc.example/'); // refused at the handshake — never opens
    const s = m.snapshot().hosts[0]!.sockets;
    expect(s).toMatchObject({ opened: 1, neverOpened: 1 });
  });

  it('records close codes, so 1006 is distinguishable from a clean close', () => {
    const { m, make } = wire();
    const refused = make('wss://rpc.example/');
    refused.emit('close', { code: 1006 });   // abnormal: never established
    const dropped = make('wss://rpc.example/');
    dropped.emit('open');
    dropped.emit('close', { code: 1000 });   // normal
    const s = m.snapshot().hosts[0]!.sockets;
    expect(s.closed).toBe(2);
    expect(s.closeCodes).toEqual({ '1006': 1, '1000': 1 });
    expect(s.opened).toBe(1);
    expect(s.neverOpened).toBe(1);
  });

  it('keeps sockets out of the HTTP status buckets', () => {
    // Otherwise a socket would land in `failed` and read as a network error.
    const { m, make } = wire();
    make('wss://rpc.example/');
    const host = m.snapshot().hosts[0]!;
    expect(host.byStatus.failed).toBe(0);
    expect(host.total).toBe(1);
    expect(host.sockets.neverOpened).toBe(1);
  });

  it('still counts sockets toward the rate', () => {
    // Reconnect storms are exactly what a rate limiter sees.
    const { m, make } = wire();
    for (let i = 0; i < 6; i++) make('wss://rpc.example/');
    expect(m.snapshot().hosts[0]!.peakPerSecond).toBe(6);
  });
});

// Counts tell you a request failed; they do not let you reproduce it outside the
// wallet. These cover the capture that does — and, more importantly, what it
// must not carry into a terminal.
// Capture is fire-and-forget by design: awaiting it would add the cost of
// cloning and reading a body to every failed request the wallet makes. Tests
// therefore have to let the microtasks drain before reading a snapshot.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('failure capture', () => {
  const wireFetch = (impl: () => Promise<Response>) => {
    const m = createRequestMeter();
    const target = { fetch: impl as unknown as typeof fetch, WebSocket: class {} as never };
    installRequestMeter(m, target);
    return { m, target };
  };

  it('captures a failing request in full, and leaves the response readable', async () => {
    const { m, target } = wireFetch(async () => new Response('{"error":"forbidden"}', { status: 403, statusText: 'Forbidden' }));
    const res = await target.fetch('https://rpc.example/', {
      method: 'POST',
      body: '{"jsonrpc":"2.0","method":"chain_getBlock"}',
      headers: { 'content-type': 'application/json' },
    });
    // The caller's own body must be untouched by the capture.
    expect(await res.text()).toBe('{"error":"forbidden"}');

    await flush();
    const f = m.snapshot().failures[0]!;
    expect(f.status).toBe(403);
    expect(f.statusText).toBe('Forbidden');
    expect(f.method).toBe('POST');
    expect(f.body).toContain('chain_getBlock');
    expect(f.responseBody).toContain('forbidden');
  });

  it('captures nothing for a successful request', async () => {
    const { m, target } = wireFetch(async () => new Response('ok', { status: 200 }));
    await target.fetch('https://rpc.example/');
    await flush();
    expect(m.snapshot().failures).toEqual([]);
  });

  it('redacts anything that looks like a credential', async () => {
    const { m, target } = wireFetch(async () => new Response('', { status: 403 }));
    await target.fetch('https://rpc.example/', {
      headers: { 'x-shielded-ratelimit-bypass': 'hunter2', authorization: 'Bearer abc', 'content-type': 'application/json' },
    });
    await flush();
    const f = m.snapshot().failures[0]!;
    expect(JSON.stringify(f.headers)).not.toContain('hunter2');
    expect(JSON.stringify(f.headers)).not.toContain('abc');
    expect(f.headers['content-type']).toBe('application/json'); // benign ones survive
  });

  it('does not consume a streamed body', async () => {
    // Reading it would take it from the request the wallet is making.
    const { m, target } = wireFetch(async () => new Response('', { status: 500 }));
    const stream = new Blob(['x']).stream();
    await target.fetch('https://rpc.example/', { method: 'POST', body: stream as unknown as BodyInit });
    await flush();
    expect(m.snapshot().failures[0]!.body).toBeNull();
  });

  it('records a network failure with no response', async () => {
    const m = createRequestMeter();
    const target = {
      fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await expect(target.fetch('https://rpc.example/')).rejects.toThrow();
    await flush();
    const f = m.snapshot().failures[0]!;
    expect(f.status).toBeNull();
    expect(f.statusText).toBe('offline');
  });

  it('keeps only the most recent failures, newest first', async () => {
    const { m, target } = wireFetch(async () => new Response('', { status: 500 }));
    for (let i = 0; i < MAX_FAILURES + 3; i++) await target.fetch(`https://rpc.example/${i}`);
    await flush();
    const f = m.snapshot().failures;
    expect(f).toHaveLength(MAX_FAILURES);
    expect(f[0]!.url).toContain(`/${MAX_FAILURES + 2}`); // newest first
  });

  it('truncates a large body rather than holding it', async () => {
    const { m, target } = wireFetch(async () => new Response('y'.repeat(MAX_BODY_CHARS * 2), { status: 500 }));
    await target.fetch('https://rpc.example/', { method: 'POST', body: 'x'.repeat(MAX_BODY_CHARS * 2) });
    await flush();
    const f = m.snapshot().failures[0]!;
    expect(f.body!.length).toBeLessThan(MAX_BODY_CHARS + 50);
    expect(f.body).toContain('[truncated]');
    expect(f.responseBody).toContain('[truncated]');
  });
});

// The relay probe GETs the JSON-RPC endpoint once a minute to be rejected: a
// healthy node answers 405, and any HTTP answer proves it is alive. Capturing
// that as a failure filled every slot with the same expected 405 and evicted the
// 403s the panel exists to preserve.
describe('expected rejections', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('does not spend a capture slot on the relay probe', async () => {
    const m = createRequestMeter();
    const target = {
      fetch: (async () => new Response('Used HTTP Method is not allowed. POST is required', { status: 405 })) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await target.fetch('https://rpc.example/', { method: 'GET' });
    await flush();
    expect(m.snapshot().failures).toEqual([]);
  });

  it('still counts it, because volume is volume', async () => {
    const m = createRequestMeter();
    const target = {
      fetch: (async () => new Response('', { status: 405 })) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await target.fetch('https://rpc.example/', { method: 'GET' });
    await flush();
    const host = m.snapshot().hosts[0]!;
    expect(host.totalAllTime).toBe(1);
    expect(host.byStatus.otherClientError).toBe(1);
    expect(host.statusCounts['405']).toBe(1);
  });

  it('keeps a 403 that a minute of probes would otherwise have evicted', async () => {
    // The failure this whole feature exists to preserve.
    const m = createRequestMeter();
    let status = 403;
    const target = {
      fetch: (async () => new Response('', { status })) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await target.fetch('https://rpc.example/rpc', { method: 'POST', body: '{}' });
    await flush();

    status = 405;
    for (let i = 0; i < MAX_FAILURES * 3; i++) await target.fetch('https://rpc.example/', { method: 'GET' });
    await flush();

    const failures = m.snapshot().failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]!.status).toBe(403);
  });

  it('captures a 405 that was not a probe', async () => {
    // A POST getting 405 is a genuine surprise and must still be replayable.
    const m = createRequestMeter();
    const target = {
      fetch: (async () => new Response('', { status: 405 })) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await target.fetch('https://rpc.example/', { method: 'POST', body: '{}' });
    await flush();
    expect(m.snapshot().failures[0]!.status).toBe(405);
  });
});

describe('asCurl', () => {
  it('produces a runnable command with the body and headers', async () => {
    const m = createRequestMeter();
    const target = {
      fetch: (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await target.fetch('https://rpc.preprod.midnight.network/', {
      method: 'POST',
      body: '{"jsonrpc":"2.0"}',
      headers: { 'content-type': 'application/json' },
    });
    await flush();
    const cmd = asCurl(m.snapshot().failures[0]!);
    expect(cmd).toContain("curl -i -X POST 'https://rpc.preprod.midnight.network/'");
    expect(cmd).toContain("-H 'content-type: application/json'");
    expect(cmd).toContain('{"jsonrpc":"2.0"}');
  });

  it('emits the node auth header as a variable, since JS never saw it', async () => {
    // declarativeNetRequest injects it after JS, so a faithful replay has to
    // supply it — a command that silently omits it fails differently.
    const m = createRequestMeter();
    const target = {
      fetch: (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
      WebSocket: class {} as never,
    };
    installRequestMeter(m, target);
    await target.fetch('https://rpc.preprod.midnight.network/');
    await flush();
    const cmd = asCurl(m.snapshot().failures[0]!);
    expect(cmd).toContain('$MOTH_NODE_AUTH');
  });
});

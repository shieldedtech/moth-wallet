// How many requests the wallet is making, to whom, and how fast.
//
// Written to answer a specific question: one person sees HTTP 403 from the node
// and nobody else does. 403 there means rate limiting, so the useful evidence is
// request volume — but nothing measured it, and "it feels like a lot" is not
// something you can take to whoever runs the endpoint.
//
// Counts in the offscreen worker, because that is where the traffic is. The
// wallet SDK drives sync from there with its own fetch and WebSocket calls, so
// counting only our own IndexerClient would miss most of it. Wrapping the
// globals catches everything in the context, ours and the SDK's alike.
//
// The window is a plain array of timestamps per host. Bounded by pruning on
// every read, so a long session cannot grow it without limit, and cheap enough
// to leave on: an array push per request against a network round trip.

/** Rolling window. Nothing older than this is retained, so the five-minute
 *  figure is always answerable and memory stays bounded. */
export const WINDOW_MS = 5 * 60_000;

/** Per-host figures.
 *
 *  Split deliberately between two timescales. The RATES are windowed, because a
 *  rate over all time is meaningless. Everything else — totals, outcomes, the
 *  peak, socket results — is kept for the life of the meter and survives the
 *  window emptying.
 *
 *  That split is the whole point. This page gets opened minutes after the thing
 *  it is meant to explain: you see a 403, you go find the debug page, you read
 *  it. An earlier version pruned a host out of existence once its last request
 *  aged past five minutes, so a quiet wallet showed nothing at all and the two
 *  403s that prompted the visit were gone. Evidence has to outlive the window
 *  that produced it. */
export interface HostStats {
  host: string;
  /** Requests in the last five minutes. Zero is normal on a quiet wallet, and is
   *  itself informative — it means the rates below are not the story. */
  total: number;
  /** Every request to this host since the meter started. Never pruned. */
  totalAllTime: number;
  /** Outcomes over the life of the meter, so a rate can be read against what it
   *  produced. `failed` is a network-level failure — no HTTP response at all. */
  byStatus: { ok: number; forbidden: number; otherClientError: number; serverError: number; failed: number };
  /** Every distinct status seen, with counts. Keeps 403 visible next to whatever
   *  else the endpoint returned rather than collapsing it into a bucket. */
  statusCounts: Record<string, number>;
  /** Requests in the last second, as a rate. */
  perSecond: number;
  /** Mean over the last minute — steadier than perSecond for spotting a floor. */
  perSecondAvg60: number;
  /** Busiest single second ever seen, and when it was.
   *
   *  The number a rate limiter actually trips on. A mean of 0.8/s reads as
   *  harmless while a burst of 40 in one second is what gets refused, and by the
   *  time anyone opens this page the burst is usually over — so it is computed
   *  as each request arrives and kept, never recomputed from a list that pruning
   *  may since have emptied. */
  peakPerSecond: number;
  /** Start of the busiest second, or null when nothing has been recorded. */
  peakAt: number | null;
  /** Wall-clock ms since the most recent request, at any age. Null until the
   *  first request. Says how stale everything above it is. */
  sinceLastMs: number | null;
  /** WebSocket outcomes over the life of the meter, which have no HTTP status of
   *  their own.
   *
   *  A socket refused at the handshake never opens and closes with 1006
   *  (abnormal). One that opens and is later dropped closes with a code the
   *  server chose. Distinguishing them matters: the first is "you were not let
   *  in", the second is "you were, then something ended it" — and an HTTP
   *  counter alone cannot tell them apart, which is why eight of ten rpc
   *  requests showed no outcome at all. */
  sockets: { opened: number; neverOpened: number; closed: number; closeCodes: Record<string, number> };
}

/** Enough of a failed request to replay it from a shell.
 *
 *  Captured ONLY for failures, and only the last few, because unlike the counts
 *  this is not safe to paste anywhere without reading it first: a request body
 *  can carry addresses and transaction data. The debug page labels it as such.
 */
export interface RequestFailure {
  at: number;
  method: string;
  url: string;
  /** Headers set by the caller. Note the node auth header is NOT here — it is
   *  injected by declarativeNetRequest after JS, so a replay has to add it. */
  headers: Record<string, string>;
  /** Request body, truncated. Only captured when it is already a string —
   *  streams are not consumed, since reading one would take it from the request
   *  the wallet is trying to make. */
  body: string | null;
  /** HTTP status, or null when the request failed before a response. */
  status: number | null;
  statusText: string;
  /** Response body, truncated. Read from a clone so the caller still gets an
   *  unread body. */
  responseBody: string | null;
}

/** Kept small on purpose: enough to see a pattern, not a log. */
export const MAX_FAILURES = 5;
/** Bodies are truncated — a GraphQL query is worth seeing, a 2 MB response is not. */
export const MAX_BODY_CHARS = 2_000;

export interface MeterSnapshot {
  /** When the snapshot was taken. */
  at: number;
  /** How long the meter has been running, so a rate can be read in context. */
  uptimeMs: number;
  hosts: HostStats[];
  /** Every host combined — the number to quote when asking about rate limits. */
  totalInWindow: number;
  /** The most recent failures, newest first, with enough detail to replay. */
  failures: RequestFailure[];
}

/**
 * A counter over timestamped events, grouped by host.
 *
 * Pure: no fetch, no WebSocket, no clock of its own. The rate arithmetic is the
 * part worth testing and it should be testable without a network.
 */
/** Host for grouping. An unparseable URL is kept whole rather than dropped — an
 *  endpoint odd enough not to parse is itself worth seeing. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function createRequestMeter(now: () => number = Date.now) {
  const started = now();
  const failures: RequestFailure[] = [];
  interface Entry {
    at: number;
    /** HTTP status, or null for a network-level failure. Undefined until the
     *  response resolves — a request in flight has no outcome yet. */
    status?: number | null;
    /** Set for WebSocket entries, which never carry an HTTP status. */
    socket?: { opened: boolean; closeCode?: number };
  }
  const byHost = new Map<string, Entry[]>();

  /** What is kept forever. Bounded by the number of distinct hosts the wallet
   *  talks to — a handful — rather than by request count, so retaining it costs
   *  nothing while the entry lists stay pruned. */
  interface Lifetime {
    total: number;
    byStatus: HostStats['byStatus'];
    statusCounts: Record<string, number>;
    sockets: HostStats['sockets'];
    peakPerSecond: number;
    peakAt: number | null;
    lastAt: number;
  }
  const lifetimes = new Map<string, Lifetime>();

  const lifetimeOf = (host: string): Lifetime => {
    let l = lifetimes.get(host);
    if (!l) {
      l = {
        total: 0,
        byStatus: { ok: 0, forbidden: 0, otherClientError: 0, serverError: 0, failed: 0 },
        statusCounts: {},
        sockets: { opened: 0, neverOpened: 0, closed: 0, closeCodes: {} },
        peakPerSecond: 0,
        peakAt: null,
        lastAt: 0,
      };
      lifetimes.set(host, l);
    }
    return l;
  };

  const prune = (at: number): void => {
    for (const [host, times] of byHost) {
      // Timestamps are appended in order, so the first index still inside the
      // window is where the survivors begin.
      let i = 0;
      while (i < times.length && at - times[i]!.at > WINDOW_MS) i++;
      if (i > 0) times.splice(0, i);
      // The entry list goes; the host does not. Its lifetime figures are what
      // someone opening this page ten minutes after a 403 came to read.
      if (times.length === 0) byHost.delete(host);
    }
  };

  return {
    /** Record one request to `url`. Unparseable URLs are grouped under their raw
     *  value rather than dropped — an odd endpoint is itself worth seeing. */
    /** Record one request to `url`, counted from the moment it is SENT — that is
     *  what a rate limiter sees. Returns a callback to attach the outcome once
     *  the response resolves; calling it is optional, and an unresolved request
     *  simply has no status. */
    record(url: string): (status: number | null) => void {
      const at = now();
      const host = hostOf(url);
      const entry: Entry = { at };
      const entries = byHost.get(host);
      if (entries) entries.push(entry);
      else byHost.set(host, [entry]);

      const life = lifetimeOf(host);
      life.total++;
      life.lastAt = at;

      // Peak is computed here, as each request arrives, rather than swept from
      // the entry list at snapshot time — pruning may have emptied that list
      // long before anyone looks. Counting backwards from the new entry finds
      // the busiest second ending now; every maximal one-second window ends at
      // some request, so taking the max across arrivals finds them all.
      const list = byHost.get(host)!;
      let k = list.length - 1;
      while (k >= 0 && at - list[k]!.at < 1_000) k--;
      const inLastSecond = list.length - 1 - k;
      if (inLastSecond > life.peakPerSecond) {
        life.peakPerSecond = inLastSecond;
        life.peakAt = list[k + 1]!.at;
      }

      return (status: number | null) => {
        entry.status = status;
        const key = status === null ? 'failed' : String(status);
        life.statusCounts[key] = (life.statusCounts[key] ?? 0) + 1;
        if (status === null) life.byStatus.failed++;
        else if (status === 403) life.byStatus.forbidden++;
        else if (status >= 500) life.byStatus.serverError++;
        else if (status >= 400) life.byStatus.otherClientError++;
        else life.byStatus.ok++;
      };
    },

    /** Record a WebSocket connection attempt, returning handles for its
     *  lifecycle. Separate from `record` because a socket has no status: what it
     *  has is whether it ever opened, and how it closed. */
    recordSocket(url: string): { onOpen: () => void; onClose: (code: number) => void } {
      // Deliberately does NOT call the settle callback record() returns: that
      // buckets an HTTP status, and a socket has none. Settling it as `null`
      // would file every WebSocket under "network failure".
      this.record(url);
      const host = hostOf(url);
      const entries = byHost.get(host);
      const entry = entries?.[entries.length - 1];
      if (entry) entry.socket = { opened: false };

      const life = lifetimeOf(host);
      life.sockets.neverOpened++; // moved to `opened` if the handshake completes
      let opened = false;
      return {
        onOpen: () => {
          if (entry?.socket) entry.socket.opened = true;
          if (!opened) {
            opened = true;
            life.sockets.neverOpened--;
            life.sockets.opened++;
          }
        },
        onClose: (code: number) => {
          if (entry?.socket) entry.socket.closeCode = code;
          life.sockets.closed++;
          const c = String(code);
          life.sockets.closeCodes[c] = (life.sockets.closeCodes[c] ?? 0) + 1;
        },
      };
    },

    snapshot(): MeterSnapshot {
      const at = now();
      prune(at);
      const hosts: HostStats[] = [];
      let totalInWindow = 0;
      // Iterates the lifetime map, not the pruned window, so a host that has
      // been quiet for an hour still reports — with `total: 0` and its outcomes
      // intact.
      for (const [host, life] of lifetimes) {
        const entries = byHost.get(host) ?? [];
        const lastSecond = entries.filter((e) => at - e.at <= 1_000).length;
        const lastMinute = entries.filter((e) => at - e.at <= 60_000).length;
        totalInWindow += entries.length;

        hosts.push({
          host,
          total: entries.length,
          totalAllTime: life.total,
          byStatus: { ...life.byStatus },
          statusCounts: { ...life.statusCounts },
          perSecond: lastSecond,
          // Rounded to 2dp: a rate like 0.83/s is the useful precision, and
          // 0.8333333333333334 in a bug report is noise.
          perSecondAvg60: Math.round((lastMinute / 60) * 100) / 100,
          peakPerSecond: life.peakPerSecond,
          peakAt: life.peakAt,
          sockets: { ...life.sockets, closeCodes: { ...life.sockets.closeCodes } },
          sinceLastMs: life.lastAt > 0 ? at - life.lastAt : null,
        });
      }
      // Busiest first, by lifetime volume rather than by the window — the host
      // you are being rate-limited by should not slide down the table just
      // because it has gone quiet since.
      hosts.sort((a, b) => b.totalAllTime - a.totalAllTime);
      return { at, uptimeMs: at - started, hosts, totalInWindow, failures: [...failures] };
    },

    /** Record a failed request in full. Newest first, oldest dropped past the cap. */
    recordFailure(failure: Omit<RequestFailure, 'at'>): void {
      failures.unshift({ at: now(), ...failure });
      if (failures.length > MAX_FAILURES) failures.length = MAX_FAILURES;
    },

    /** Clears everything, including the lifetime figures — an explicit "start
     *  again from here" for someone about to reproduce a problem. Nothing else
     *  drops the lifetime counters; that is the point of them. */
    reset(): void {
      byHost.clear();
      lifetimes.clear();
      failures.length = 0;
    },
  };
}

export type RequestMeter = ReturnType<typeof createRequestMeter>;

/**
 * Wrap `fetch` and `WebSocket` on `target` so every call is counted.
 *
 * Returns an uninstall function. Deliberately transparent: the wrappers do not
 * alter arguments, results or errors, so a bug here cannot change what the
 * wallet sends — a diagnostic must not become a variable in the thing it
 * measures.
 *
 * WebSocket construction is counted, not messages. The node relay holds one
 * long-lived socket, so message volume says little about rate limiting, whereas
 * repeated construction is exactly what a backoff failure looks like.
 */
export function installRequestMeter(
  meter: RequestMeter,
  target: { fetch: typeof fetch; WebSocket: typeof WebSocket } = globalThis as never,
): () => void {
  const originalFetch = target.fetch;
  const OriginalWebSocket = target.WebSocket;

  target.fetch = function meteredFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let settle: ((status: number | null) => void) | undefined;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      settle = meter.record(url);
    } catch {
      /* never let counting break a request */
    }
    // The outcome is attached when the response resolves, but the request is
    // counted from when it was sent — that is what a rate limiter sees, and a
    // request that is still in flight has genuinely produced no status yet.
    return originalFetch.call(this as never, input as RequestInfo, init).then(
      (response) => {
        settle?.(response.status);
        // Capture enough of a failure to replay it. Only on failure: doing it
        // always would mean holding request and response bodies for every sync
        // poll, which is both wasteful and a privacy problem nobody asked for.
        if (!response.ok && !isExpectedRejection(methodOf(input, init), response.status)) {
          void captureFailure(meter, input, init, response).catch(() => {});
        }
        return response;
      },
      (error: unknown) => {
        settle?.(null); // no HTTP response at all
        void captureFailure(meter, input, init, null, error).catch(() => {});
        throw error;
      },
    );
  } as typeof fetch;

  target.WebSocket = new Proxy(OriginalWebSocket, {
    construct(t, args: [string | URL, (string | string[])?]) {
      const socket = Reflect.construct(t, args) as WebSocket;
      try {
        const handles = meter.recordSocket(typeof args[0] === 'string' ? args[0] : args[0].href);
        // Passive listeners: they observe, never preventDefault or stopPropagation,
        // so the SDK's own handlers see exactly what they would have seen.
        socket.addEventListener('open', () => handles.onOpen());
        socket.addEventListener('close', (e) => handles.onClose((e as CloseEvent).code));
      } catch {
        /* never let counting break a connection */
      }
      return socket;
    },
  });

  return () => {
    target.fetch = originalFetch;
    target.WebSocket = OriginalWebSocket;
  };
}

/** The meter for this context. A module singleton because the worker installs it
 *  at module scope (before the SDK captures the globals) while the host reads it
 *  from a message handler — passing an instance between them would mean one
 *  importing the other, and the worker imports the host. */
export const requestMeter = createRequestMeter();

/** Truncate with a marker, so a reader can tell a short body from a cut one. */
function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}… [truncated]` : text;
}

/** Headers a caller set, lower-cased. Anything that looks like a credential is
 *  replaced: this is meant to be pasted into a terminal, and people paste more
 *  than they read. */
const SENSITIVE = /auth|token|cookie|secret|key|bypass/i;

function headersOf(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const collect = (h: HeadersInit | undefined): void => {
    if (!h) return;
    const entries =
      h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
    for (const [k, v] of entries) {
      out[k.toLowerCase()] = SENSITIVE.test(k) ? '[redacted]' : String(v);
    }
  };
  if (typeof input === 'object' && 'headers' in input) collect((input as Request).headers);
  collect(init?.headers);
  return out;
}

/** The method a fetch call will actually use, mirroring the platform default. */
function methodOf(input: RequestInfo | URL, init: RequestInit | undefined): string {
  return (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
}

/**
 * True for a rejection the wallet asked for on purpose.
 *
 * The relay probe (offscreen/relay-socket.ts) GETs the JSON-RPC endpoint once a
 * minute precisely to be rejected: a healthy Midnight node answers 405, and any
 * HTTP answer at all proves the endpoint is alive. Capturing that as a failure
 * filled all five slots with the same expected 405 within five minutes and
 * evicted the 403s this panel exists to preserve — the counts still include it,
 * since volume is volume, but it does not consume the evidence buffer.
 */
export function isExpectedRejection(method: string, status: number): boolean {
  return method === 'GET' && status === 405;
}

async function captureFailure(
  meter: RequestMeter,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response | null,
  error?: unknown,
): Promise<void> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = methodOf(input, init);

  // Only read a body that is already a string. A stream would have to be
  // consumed to be read, and consuming it would take it from the request the
  // wallet is actually trying to make — a diagnostic must not do that.
  const rawBody = init?.body;
  const body = typeof rawBody === 'string' ? truncate(rawBody) : null;

  let responseBody: string | null = null;
  if (response) {
    try {
      // Clone first: the caller still needs to read the real response.
      responseBody = truncate(await response.clone().text());
    } catch {
      responseBody = null;
    }
  }

  meter.recordFailure({
    method,
    url,
    headers: headersOf(input, init),
    body,
    status: response?.status ?? null,
    statusText: response?.statusText ?? (error instanceof Error ? error.message : 'request failed'),
    responseBody,
  });
}

/**
 * A failure as a runnable curl command.
 *
 * The node auth header is deliberately emitted as a shell variable rather than a
 * value: it is injected by declarativeNetRequest after JS, so it was never
 * visible to capture in the first place, and a replay needs it supplied. Making
 * that explicit is better than a command that silently fails differently from
 * the wallet.
 */
export function asCurl(failure: RequestFailure): string {
  const parts = [`curl -i -X ${failure.method} '${failure.url}'`];
  for (const [name, value] of Object.entries(failure.headers)) {
    parts.push(`  -H '${name}: ${value}'`);
  }
  if (/rpc\./.test(failure.url)) {
    parts.push(`  -H "x-shielded-ratelimit-bypass: $MOTH_NODE_AUTH"  # set this; the wallet's copy is added by the browser, not by JS`);
  }
  if (failure.body) {
    parts.push(`  --data '${failure.body.replace(/'/g, String.raw`'\''`)}'`);
  }
  return parts.join(' \\\n');
}

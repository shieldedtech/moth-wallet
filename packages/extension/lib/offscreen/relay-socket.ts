// Backoff + reachability reporting for the node relay WebSocket.
//
// Why this exists: the wallet SDK opens the relay connection itself (the
// submission service, from `relayURL` in the facade config) and its config type
// is `{ relayURL: URL }` — there is no retry knob to pass. Underneath,
// @polkadot/rpc-provider's WsProvider retries on a flat `RETRY_DELAY = 2_500`
// with no backoff and no ceiling. Against a node that is refusing connections
// outright that is 24 doomed handshakes a minute, forever, and it buries every
// other console message under the wreckage.
//
// So we intervene one layer below the SDK, at the WebSocket constructor, which
// is ours to wrap inside the dedicated worker. While a backoff window is open we
// hand WsProvider a *stub* socket that never touches the network and reports
// failure when the window elapses. WsProvider's own 2.5s timer then fires and
// constructs again, by which point the window has passed and it gets a real
// socket. Its retry loop is untouched and unaware; we have only stretched the
// spacing between attempts that reach the wire.
//
// Deliberately not a circuit breaker that gives up. A node coming back must heal
// on its own without the user knowing to click anything, so the curve flattens
// at one attempt a minute rather than stopping.
//
// Runs INSIDE the wallet worker: no extension APIs, no WASM, no imports that
// pull either in. `fetch` and `WebSocket` are both worker globals.

/** How the relay connection currently looks to the user. */
export interface RelayState {
  status: 'connecting' | 'connected' | 'unreachable';
  /** The wss:// URL being dialled, for the developer-mode detail line. */
  url: string;
  /** HTTP status from the classification probe; null when it couldn't run. */
  httpStatus: number | null;
  /** `forbidden` = the server answered and refused (401/403). `reachable` = the
   *  server answered something else, so the endpoint is up and the socket
   *  failure was transient. `unreachable` = no answer at all (DNS, TLS, offline). */
  reason: 'forbidden' | 'reachable' | 'unreachable' | null;
  /** Consecutive failed attempts; 0 once connected. */
  attempts: number;
  /** Epoch ms of the next attempt that will reach the wire, or null. */
  nextRetryAt: number | null;
}

/** First retry matches WsProvider's own 2.5s so a one-off blip still recovers
 *  as fast as it did before; doubling from there. */
const BASE_DELAY_MS = 2_500;
/** One attempt a minute is the floor. Frequent enough that a node coming back
 *  is noticed within a minute, rare enough to be invisible in the console. */
const MAX_DELAY_MS = 60_000;
/** ±20%, so many wallets failing against one endpoint don't resynchronise into
 *  a thundering herd on the minute boundary. */
const JITTER = 0.2;

/**
 * Consecutive failures before an outage is reported to the user.
 *
 * A single failed socket is ordinary: connections drop, and the facade
 * re-establishes its relay during startup and network switches. Reporting the
 * first one told users "Can't reach the node" every time they opened the wallet,
 * on healthy networks. Three failures is ~17s of trying under the backoff curve,
 * which is long enough to mean something.
 *
 * A refusal (401/403) bypasses this and reports immediately: the server answered,
 * so there is nothing transient to wait out.
 */
const FAILURES_BEFORE_REPORTING = 3;

/**
 * Delay before the attempt following `attempts` consecutive failures.
 *
 * 1 → 2.5s, 2 → 5s, 3 → 10s, 4 → 20s, 5 → 40s, 6+ → 60s, each ±20%.
 * `random` is injectable so the curve is testable without stubbing Math.random.
 */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  if (attempts <= 0) return 0;
  const exponential = BASE_DELAY_MS * 2 ** (attempts - 1);
  const capped = Math.min(exponential, MAX_DELAY_MS);
  // random() ∈ [0,1) → factor ∈ [0.8, 1.2)
  return Math.round(capped * (1 - JITTER + random() * 2 * JITTER));
}

/**
 * What a probe's HTTP status says about the endpoint.
 *
 * A GET against a WebSocket/JSON-RPC endpoint is *supposed* to be rejected — a
 * healthy Midnight node answers 405 (method not allowed). Any HTTP response at
 * all proves something is listening and answering, which is the whole point of
 * probing: it separates "this endpoint is down" from "that particular socket
 * failed".
 *
 * 401/403 is the server answering AND refusing us specifically. Only the absence
 * of any response is unreachability.
 *
 * This used to fold 405 into `unreachable`, so a probe that proved the endpoint
 * was healthy still read as an outage — and the banner reported "Can't reach the
 * node" while displaying "HTTP 405" underneath it.
 */
export function classifyProbe(status: number | null): RelayState['reason'] {
  if (status === null) return 'unreachable';
  if (status === 401 || status === 403) return 'forbidden';
  return 'reachable';
}

/** wss://host/path → https://host/path, so the classification probe can use
 *  fetch (which reports a status; a failed WS handshake does not). */
function toHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

/**
 * Normalise a URL the way the platform does, so two spellings of one endpoint
 * compare equal.
 *
 * This is load-bearing rather than tidy. Core builds the SDK's relay URL as
 * `new URL(toWsUrl(network.nodeUrl))`, and URL normalisation appends the root
 * path: the config's `https://rpc.preprod.midnight.network` becomes
 * `wss://rpc.preprod.midnight.network/`. A caller that mirrors core with a plain
 * string replace produces the same endpoint WITHOUT that slash, the two never
 * match, and every relay socket is passed through unthrottled — the backoff
 * silently does nothing, which is exactly what happened before this existed.
 */
function canonicalUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

type Listener = (state: RelayState) => void;

let relayUrl: string | null = null;
let listener: Listener | null = null;
let attempts = 0;
let nextRetryAt: number | null = null;
let httpStatus: number | null = null;
let reason: RelayState['reason'] = null;
let status: RelayState['status'] = 'connecting';
// Rate-limit the classification probe: it exists to label a failure, not to
// become a second source of traffic against an endpoint already in trouble.
let lastProbeAt = 0;
const PROBE_INTERVAL_MS = 60_000;

function snapshot(): RelayState {
  return { status, url: relayUrl ?? '', httpStatus, reason, attempts, nextRetryAt };
}

function publish(): void {
  listener?.(snapshot());
}

/** Current relay state, for a caller that wants it without subscribing. */
export function relayState(): RelayState {
  return snapshot();
}

/** Subscribe to state changes. One listener; the worker entry owns it. */
export function onRelayState(fn: Listener): void {
  listener = fn;
}

/**
 * Which URL to throttle. Set by the host from the network config as sync
 * starts; until then (and for every other socket, e.g. the indexer's) the
 * wrapper is a pass-through.
 */
export function setRelayUrl(url: string): void {
  const canonical = canonicalUrl(url);
  if (relayUrl === canonical) return;
  relayUrl = canonical;
  attempts = 0;
  nextRetryAt = null;
  httpStatus = null;
  reason = null;
  status = 'connecting';
  // A different endpoint deserves its own answer. Without this the rate limit
  // carries over and the first failure on a newly-selected network cannot be
  // classified for up to a minute — so a switch could show a stale verdict from
  // the network just left.
  lastProbeAt = 0;
  publish();
}

/**
 * Drop the backoff so the next construction dials immediately — the "Retry now"
 * button. Does not itself open a socket: WsProvider is already looping, so the
 * next turn of its loop (≤2.5s) becomes a real attempt.
 */
export function relayRetry(): RelayState {
  attempts = 0;
  nextRetryAt = null;
  status = 'connecting';
  // The user asked for a fresh attempt; the classification should be fresh too.
  lastProbeAt = 0;
  publish();
  return snapshot();
}

/** Ask the endpoint what it thinks, so a failure can be labelled rather than
 *  guessed at. Best-effort and rate-limited; a failed probe is not itself an
 *  event worth reporting. */
async function probe(url: string, force = false): Promise<void> {
  const now = Date.now();
  // `force` at the moment an outage would first be reported: that decision must
  // be made on a fresh answer, not on one up to a minute old.
  if (!force && now - lastProbeAt < PROBE_INTERVAL_MS) return;
  lastProbeAt = now;
  try {
    const response = await fetch(toHttpUrl(url), { method: 'GET' });
    httpStatus = response.status;
  } catch {
    // Blocked by CORS, DNS failure, offline — no status to report, and the
    // absence of one is itself the "unreachable" signal.
    httpStatus = null;
  }
  reason = classifyProbe(httpStatus);

  // The probe is what distinguishes "the endpoint is down" from "that socket
  // failed". Act on the answer rather than only labelling it:
  if (reason === 'forbidden') {
    // The server answered and refused. Nothing to wait out — say so now, however
    // few attempts we have made.
    status = 'unreachable';
  } else if (reason === 'reachable' && status === 'unreachable') {
    // It answered normally, so the endpoint is up and the socket failure was
    // transient. Withdraw the outage rather than leaving it on screen next to
    // the HTTP status that disproves it.
    status = 'connecting';
  }
  publish();
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

/** Minimal stand-in for a WebSocket that never connects. WsProvider only ever
 *  assigns the four handlers and calls close(), so that is all this implements —
 *  anything more would be inventing a contract nobody exercises. */
function makeStubSocket(url: string, fireAt: number): WebSocket {
  const stub = {
    url,
    readyState: 0 /* CONNECTING */,
    binaryType: 'blob' as BinaryType,
    bufferedAmount: 0,
    extensions: '',
    protocol: '',
    onopen: null,
    onerror: null,
    onclose: null,
    onmessage: null,
    close(): void {
      stub.readyState = 3 /* CLOSED */;
      clearTimeout(timer);
    },
    send(): void {
      /* never open, so nothing can be sent */
    },
    addEventListener(): void {},
    removeEventListener(): void {},
    dispatchEvent(): boolean {
      return true;
    },
  } as unknown as WebSocket & {
    readyState: number;
    onerror: ((event: Event) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
  };

  const timer = setTimeout(
    () => {
      stub.readyState = 3 /* CLOSED */;
      // Same pair a real failed handshake delivers, in the same order, so
      // WsProvider's own bookkeeping sees nothing unusual.
      stub.onerror?.(new Event('error'));
      stub.onclose?.(new CloseEvent('close', { code: 1006, reason: 'relay backoff', wasClean: false }));
    },
    Math.max(0, fireAt - Date.now()),
  );

  return stub;
}

/**
 * Wrap `globalThis.WebSocket` so relay connections obey the backoff curve.
 *
 * MUST be called before the SDK is imported — once WsProvider has captured the
 * global, a later swap is invisible to it. The worker entry does this at module
 * scope, ahead of the lazy `wallet-host` import.
 */
export function installRelayBackoff(): void {
  const NativeWebSocket = globalThis.WebSocket;
  // Idempotent: a second install would wrap our own wrapper and double the delays.
  if ((NativeWebSocket as { __mothWrapped?: boolean }).__mothWrapped) return;

  const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]): WebSocket {
    const href = typeof url === 'string' ? url : url.toString();

    // Not the relay (the indexer's socket, or sync hasn't named one yet):
    // untouched, because throttling the indexer would stall sync itself.
    // Both sides are canonicalised so a trailing-slash difference between the
    // configured endpoint and the one WsProvider dials cannot silently disable
    // the whole mechanism.
    if (relayUrl === null || canonicalUrl(href) !== relayUrl) {
      return new NativeWebSocket(url, protocols);
    }

    // Inside a backoff window: hand back a socket that costs nothing and fails
    // when the window closes.
    if (nextRetryAt !== null && Date.now() < nextRetryAt) {
      return makeStubSocket(href, nextRetryAt);
    }

    const socket = new NativeWebSocket(url, protocols);
    let settled = false;

    socket.addEventListener('open', () => {
      settled = true;
      attempts = 0;
      nextRetryAt = null;
      httpStatus = null;
      reason = null;
      status = 'connected';
      publish();
    });

    // A failed handshake fires error then close. The browser deliberately withholds
    // the HTTP status from both (it is only ever printed to the console), which is
    // why classification needs the separate fetch probe.
    const onFailure = () => {
      if (settled) {
        // Was connected and dropped: that is attempt zero of a fresh outage, not
        // a continuation of an old one.
        settled = false;
        attempts = 0;
      }
      attempts += 1;
      nextRetryAt = Date.now() + backoffDelayMs(attempts);
      // Only once failing has become a pattern. A refusal short-circuits this
      // from probe(), which knows the server answered.
      const crossing = attempts === FAILURES_BEFORE_REPORTING;
      if (attempts >= FAILURES_BEFORE_REPORTING) status = 'unreachable';
      publish();
      void probe(href, crossing);
    };

    socket.addEventListener('error', onFailure, { once: true });
    socket.addEventListener('close', () => {
      // `close` after a successful `open` is a dropped connection, which the
      // error path above hasn't seen; treat it the same way.
      if (settled) onFailure();
    });

    return socket;
  } as unknown as typeof WebSocket;

  Wrapped.prototype = NativeWebSocket.prototype;
  Object.defineProperty(Wrapped, '__mothWrapped', { value: true });
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'] as const) {
    Object.defineProperty(Wrapped, key, { value: NativeWebSocket[key] });
  }

  globalThis.WebSocket = Wrapped;
}

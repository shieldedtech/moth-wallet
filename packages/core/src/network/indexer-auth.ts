// An operator-issued header on every request to the indexer.
//
// The public indexers sit behind an edge that rate-limits by source address:
// three daemons on one host, plus midnight-js polling for inclusion, were
// enough for preprod's to answer HTTP/2 403 (`server: awselb/2.0`) under normal
// operation. Operators who run pools hold an exemption header. Nothing in moth
// accepted one, so they wrapped the process's `fetch` and `WebSocket` by hand
// and pushed a `--import` preload into each daemon through NODE_OPTIONS.
//
// This does the same thing on purpose, once, in one place. Four clients talk to
// the indexer from one process — moth's own IndexerClient, the wallet SDK's
// graphql-http query client and graphql-ws subscription client, and midnight-js's
// Apollo links — and none of them takes headers through its configuration. All
// of them use the global `fetch` and (in Node) the global `WebSocket`, so the
// header is applied there, for requests whose origin is the indexer's and no
// other. The `ws` package carries handshake headers; Node's built-in WebSocket
// does not, so with a header configured the global is replaced by a `ws`
// subclass. midnight-js accepts a WebSocket implementation directly and gets
// the same class (see `indexerWebSocketImpl`).
//
// The header is a shared secret. It is never logged, never included in
// diagnostics, and never persisted by the CLI — it comes from the environment
// or a flag (see cli/base-command.ts). In a browser no script can set headers
// on a WebSocket handshake, so the extension applies it with a
// declarativeNetRequest rule instead, as it does for the node header
// (extension/lib/background/node-auth-header.ts).

export interface AuthHeader {
  readonly name: string;
  readonly value: string;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Parse `Name: value` (or `Name=value`) into a header, or undefined for
 * anything malformed. Same rules as the extension's node header: a token name,
 * no CR/LF in the value, neither side empty.
 */
export function parseAuthHeader(raw: string | undefined | null): AuthHeader | undefined {
  if (typeof raw !== 'string') return undefined;
  const sep = raw.search(/[:=]/);
  if (sep <= 0) return undefined;
  const name = raw.slice(0, sep).trim();
  const value = raw.slice(sep + 1).trim();
  if (name === '' || value === '') return undefined;
  if (!HEADER_NAME.test(name)) return undefined;
  if (/[\r\n]/.test(value)) return undefined;
  return {name, value};
}

/** Origin (scheme + host + port) a URL belongs to, with ws/wss folded onto http/https. */
function originKey(url: string): string | null {
  try {
    const u = new URL(url);
    const scheme = u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol;
    return `${scheme}//${u.host}`;
  } catch {
    return null;
  }
}

// Process-wide registry: indexer origin → header. Several networks may be
// configured in one process (the TUI switches, the daemon hosts one), so it is
// keyed by origin rather than being a single value.
const headers = new Map<string, AuthHeader>();

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn | null = null;
let wsClass: (new (url: string | URL, protocols?: string | string[]) => unknown) | null = null;

function headerFor(url: string): AuthHeader | undefined {
  const key = originKey(url);
  return key ? headers.get(key) : undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The fetch wrapper. Exported for tests; installed by installIndexerAuthHeader. */
export function withIndexerAuth(base: FetchFn): FetchFn {
  return function authedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const header = headerFor(requestUrl(input));
    if (!header) return base(input, init);
    const merged = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    merged.set(header.name, header.value);
    return base(input, {...init, headers: merged});
  } as FetchFn;
}

/**
 * Build the header-aware WebSocket class over a `ws`-style implementation
 * (constructor `(url, protocols, options)` with `options.headers`).
 * Exported for tests; installIndexerAuthHeader builds it over the real `ws`.
 */
export function withIndexerAuthWebSocket<T extends new (...args: any[]) => any>(Base: T): T {
  return class IndexerAuthWebSocket extends Base {
    constructor(...args: any[]) {
      const [url, protocols, options] = args as [string | URL, string | string[] | undefined, Record<string, unknown> | undefined];
      const header = headerFor(typeof url === 'string' ? url : url.href);
      if (!header) {
        super(url, protocols, options);
        return;
      }
      const existing = (options?.headers as Record<string, string> | undefined) ?? {};
      super(url, protocols, {...options, headers: {...existing, [header.name]: header.value}});
    }
  } as T;
}

/** Whether any indexer header is installed in this process. */
export function hasIndexerAuthHeader(): boolean {
  return headers.size > 0;
}

/**
 * Register `header` for every request to `indexerUrl`'s origin, or remove the
 * registration when `header` is undefined. Idempotent; a later call for the
 * same origin replaces the earlier one.
 *
 * Installs the fetch wrapper on first use. In Node, with a header registered,
 * also makes the global `WebSocket` the header-carrying `ws` subclass — the
 * runtime's own WebSocket cannot send handshake headers. In a browser the
 * WebSocket half is skipped; the extension's declarativeNetRequest rule covers
 * both there.
 */
export async function installIndexerAuthHeader(indexerUrl: string, header: AuthHeader | undefined): Promise<void> {
  const key = originKey(indexerUrl);
  if (!key) return;
  if (header) headers.set(key, header);
  else headers.delete(key);
  if (headers.size === 0) return;

  if (!originalFetch && typeof globalThis.fetch === 'function') {
    // Kept unbound so the test seam can restore the very same function; the
    // wrapper calls it on globalThis, which is what a bare `fetch(...)` does.
    const original = globalThis.fetch;
    originalFetch = original;
    globalThis.fetch = withIndexerAuth(((input: RequestInfo | URL, init?: RequestInit) => original.call(globalThis, input, init)) as FetchFn);
  }

  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  if (isNode && !wsClass) {
    // The specifier goes through a variable so bundlers cannot follow it into
    // browser builds, same as wallet-sync's WebSocket polyfill.
    const specifier = 'ws';
    const mod = (await import(/* @vite-ignore */ specifier)) as {WebSocket: new (...args: any[]) => unknown};
    wsClass = withIndexerAuthWebSocket(mod.WebSocket);
    (globalThis as {WebSocket?: unknown}).WebSocket = wsClass;
  }
}

/**
 * The WebSocket implementation to hand libraries that take one (midnight-js's
 * indexerPublicDataProvider). Undefined until a header is installed, so callers
 * fall through to the library's default.
 */
export function indexerWebSocketImpl(): (new (url: string | URL, protocols?: string | string[]) => unknown) | undefined {
  return wsClass ?? undefined;
}

/** Test seam: forget every registration and restore the original fetch. */
export function __resetIndexerAuthForTests(): void {
  headers.clear();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  wsClass = null;
}

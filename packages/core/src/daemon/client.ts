// Daemon client: opens a Unix-domain socket connection, performs the
// version handshake, exposes a typed call() interface and clean shutdown.
//
// connectDaemon() is intentionally forgiving — if there's no socket file,
// or the connect is refused, it returns null instead of throwing. Callers
// (the CLI) treat null as "no daemon available, run standalone", which
// keeps the daemon optional rather than a hard dependency.

import {createConnection, type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  DaemonProtocolError,
  type Frame,
  type RpcErrorCode,
} from './protocol.js';
import type {DaemonBind} from './server.js';

export interface DaemonClient {
  /** Issue an RPC; resolves with the daemon's result or rejects with a
   *  DaemonProtocolError carrying the daemon-reported code+message. */
  call<R = unknown>(method: string, params?: unknown, opts?: {timeoutMs?: number}): Promise<R>;
  /** Close the underlying socket. In-flight calls reject with code CLOSED. */
  close(): void;
  readonly closed: boolean;
  /** Daemon-reported build identifier from the version handshake. */
  readonly daemonVersion: string;
  /** API key id this client authenticated as. Present when a `token`
   *  was passed to `connectDaemonBind`; absent for Unix-transport
   *  clients hitting a daemon with no auth handler. */
  readonly apiKeyId?: string;
}

export interface ConnectDaemonOptions {
  /** Override the per-call default. Individual call() invocations can
   *  still pass their own timeoutMs. */
  readonly defaultTimeoutMs?: number;
  /** Optional logger hook. Defaults to silent. */
  readonly onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Stage-2 token in `<id>.<secret>` format. When set, the client
   * issues an `auth` RPC after the version handshake and returns
   * null if it fails (treating "bad token" the same as "no daemon"
   * — see the connectDaemon docstring). Omit on Unix-transport
   * connections to a daemon with no auth handler.
   */
  readonly token?: string;
}

/**
 * Try to connect to the daemon at the given Unix-socket path. Stage-1
 * entry point — kept for backwards compatibility. For TCP transports
 * use `connectDaemonTcp(host, port)` or the unified
 * `connectDaemonBind(bind)`.
 *
 * Returns:
 *   - DaemonClient on successful connect + handshake
 *   - null if the file doesn't exist, the connect is refused, or the
 *     handshake reports an incompatible protocol version
 *
 * Throws only on genuinely-unexpected conditions (filesystem error,
 * malformed daemon response). Network-style failures are folded into
 * null so the CLI can fall back to standalone without a try/catch.
 */
export async function connectDaemon(
  socketPath: string,
  opts: ConnectDaemonOptions = {},
): Promise<DaemonClient | null> {
  return connectDaemonBind({transport: 'unix', socketPath}, opts);
}

/**
 * Stage-2 entry point. Connect to a daemon listening on loopback TCP
 * (or, at stage 3, a TLS-terminating reverse proxy in front of the
 * daemon's loopback bind). Same fall-back-to-null semantics as
 * `connectDaemon`.
 */
export async function connectDaemonTcp(
  host: string,
  port: number,
  opts: ConnectDaemonOptions = {},
): Promise<DaemonClient | null> {
  return connectDaemonBind({transport: 'tcp', host, port}, opts);
}

/**
 * Transport-agnostic entry point. Both `connectDaemon` and
 * `connectDaemonTcp` route through here. The handshake + dispatcher
 * setup is identical across transports — only the underlying socket
 * factory differs.
 */
export async function connectDaemonBind(
  bind: DaemonBind,
  opts: ConnectDaemonOptions = {},
): Promise<DaemonClient | null> {
  const log = opts.onLog ?? (() => {});
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;

  const sock = await openSocket(bind, log);
  if (!sock) return null;

  const dispatcher = new ClientDispatcher(sock, defaultTimeoutMs, log);

  let handshake: {protocol: string; daemon: string};
  try {
    handshake = await dispatcher.call<{protocol: string; daemon: string}>('version', undefined, {
      timeoutMs: 2000,
    });
  } catch (err) {
    log('warn', `daemon handshake failed: ${(err as Error).message}`);
    dispatcher.close();
    return null;
  }

  if (handshake.protocol !== PROTOCOL_VERSION) {
    log(
      'warn',
      `daemon speaks protocol ${handshake.protocol}; client expects ${PROTOCOL_VERSION}`,
    );
    dispatcher.close();
    return null;
  }

  // Stage-2 auth handshake. Only performed when the caller passes
  // a token; daemons running without an auth handler (typical Unix
  // case) will reject an `auth` call with METHOD_NOT_FOUND, so we
  // gate on the token's presence rather than probing.
  let apiKeyId: string | undefined;
  if (opts.token) {
    try {
      const authResult = await dispatcher.call<{apiKeyId: string}>(
        'auth',
        {token: opts.token},
        {timeoutMs: 2000},
      );
      apiKeyId = authResult.apiKeyId;
    } catch (err) {
      const code = err instanceof DaemonProtocolError ? err.code : 'INTERNAL_ERROR';
      log('warn', `daemon auth failed (${code}): ${(err as Error).message}`);
      dispatcher.close();
      return null;
    }
  }

  return {
    call: dispatcher.call.bind(dispatcher),
    close: dispatcher.close.bind(dispatcher),
    get closed() {
      return dispatcher.closed;
    },
    daemonVersion: handshake.daemon,
    apiKeyId,
  };
}

function openSocket(
  bind: DaemonBind,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): Promise<Socket | null> {
  const target =
    bind.transport === 'unix'
      ? bind.socketPath
      : `${bind.host}:${bind.port}`;
  return new Promise<Socket | null>((resolve) => {
    const sock =
      bind.transport === 'unix'
        ? createConnection(bind.socketPath)
        : createConnection({host: bind.host, port: bind.port});
    const onConnect = () => {
      sock.off('error', onError);
      resolve(sock);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      sock.off('connect', onConnect);
      sock.destroy();
      // ENOENT (no socket file) and ECONNREFUSED (no listener) both
      // mean "no daemon available" rather than a real error. Apply
      // the same fall-back-to-null to both transports.
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        log('info', `no daemon at ${target} (${err.code})`);
      } else {
        log('warn', `daemon connect failed: ${err.message}`);
      }
      resolve(null);
    };
    sock.once('connect', onConnect);
    sock.once('error', onError);
  });
}

class ClientDispatcher {
  closed = false;

  private readonly sock: Socket;
  private readonly defaultTimeoutMs: number;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<
    string,
    {resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout}
  >();
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;

  constructor(
    sock: Socket,
    defaultTimeoutMs: number,
    log: (level: 'info' | 'warn' | 'error', msg: string) => void,
  ) {
    this.sock = sock;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.log = log;

    sock.on('data', (chunk: Buffer) => this.onData(chunk));
    sock.on('close', () => this.failAllPending(new DaemonProtocolError('CLOSED', 'daemon connection closed')));
    sock.on('error', (err) => {
      this.log('warn', `daemon socket error: ${err.message}`);
      this.failAllPending(new DaemonProtocolError('CLOSED', err.message));
    });
  }

  call<R>(method: string, params: unknown, opts: {timeoutMs?: number} = {}): Promise<R> {
    if (this.closed) {
      return Promise.reject(new DaemonProtocolError('CLOSED', 'daemon client is closed'));
    }
    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonProtocolError('TIMEOUT', `call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      try {
        this.sock.write(encodeFrame({id, type: 'request', method, params}));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAllPending(new DaemonProtocolError('CLOSED', 'client closed'));
    this.sock.destroy();
  }

  private onData(chunk: Buffer): void {
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.log('warn', `daemon sent malformed frame: ${(err as Error).message}`);
      this.close();
      return;
    }
    for (const frame of frames) {
      if (frame.type !== 'response') {
        this.log('warn', `daemon sent unexpected frame type ${frame.type}`);
        continue;
      }
      const waiter = this.pending.get(frame.id);
      if (!waiter) {
        // Unsolicited response — possible if a timeout already fired.
        // Drop silently rather than warn; that's expected under timeout.
        continue;
      }
      this.pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) {
        waiter.reject(new DaemonProtocolError(frame.error.code as RpcErrorCode, frame.error.message));
      } else {
        waiter.resolve(frame.result);
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }
}

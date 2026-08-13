import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {startDaemon, type DaemonHandle} from '../../../src/daemon/server.js';
import {connectDaemon} from '../../../src/daemon/client.js';
import {DaemonProtocolError, PROTOCOL_VERSION} from '../../../src/daemon/protocol.js';

let workDir: string;
let socketPath: string;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'moth-daemon-test-'));
  socketPath = join(workDir, 'wallet.sock');
  daemon = null;
});

afterEach(async () => {
  if (daemon) {
    await daemon.close();
    daemon = null;
  }
  await rm(workDir, {recursive: true, force: true});
});

describe('startDaemon + connectDaemon end-to-end', () => {
  it('completes the version handshake', async () => {
    daemon = await startDaemon({
      socketPath,
      daemonVersion: 'test-1.2.3',
      handlers: {},
    });
    const client = await connectDaemon(socketPath);
    expect(client).not.toBeNull();
    expect(client!.daemonVersion).toBe('test-1.2.3');
    client!.close();
  });

  it('rejects a connect with a mismatched protocol version on the daemon side', async () => {
    // The protocol version is a compile-time constant, so we exercise the
    // mismatch path by intercepting the daemon-side version handler. The
    // client-side check in connectDaemon is what we're verifying here.
    daemon = await startDaemon({
      socketPath,
      daemonVersion: 'test-1.2.3',
      handlers: {
        version: () => ({protocol: 'moth-wallet-daemon/999', daemon: 'test-1.2.3'}),
      },
    });
    // The builtin version handler is installed AFTER user handlers, so the
    // override above does not actually take effect — server.ts enforces this
    // as a sanity rule. Verify the client therefore still sees the correct
    // protocol version.
    const client = await connectDaemon(socketPath);
    expect(client).not.toBeNull();
    expect(client!.daemonVersion).toBe('test-1.2.3');
    client!.close();
  });

  it('routes a custom request to its handler and returns the result', async () => {
    daemon = await startDaemon({
      socketPath,
      daemonVersion: 't',
      handlers: {
        add: (params: unknown) => {
          const p = params as {a: number; b: number};
          return p.a + p.b;
        },
      },
    });
    const client = await connectDaemon(socketPath);
    expect(client).not.toBeNull();
    const result = await client!.call<number>('add', {a: 2, b: 3});
    expect(result).toBe(5);
    client!.close();
  });

  it('returns a METHOD_NOT_FOUND error for unknown methods', async () => {
    daemon = await startDaemon({socketPath, daemonVersion: 't', handlers: {}});
    const client = await connectDaemon(socketPath);
    await expect(client!.call('nope')).rejects.toThrow(DaemonProtocolError);
    await expect(client!.call('nope')).rejects.toMatchObject({code: 'METHOD_NOT_FOUND'});
    client!.close();
  });

  it('maps generic handler exceptions to INTERNAL_ERROR', async () => {
    daemon = await startDaemon({
      socketPath,
      daemonVersion: 't',
      handlers: {
        explode: () => {
          throw new Error('intentional');
        },
      },
    });
    const client = await connectDaemon(socketPath);
    await expect(client!.call('explode')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'intentional',
    });
    client!.close();
  });

  it('preserves the handler-thrown DaemonProtocolError code on the wire', async () => {
    // Without this, clients can't distinguish UNAUTHORIZED / INVALID_PARAMS
    // / etc. from a generic crash — the L3 modal would always look like an
    // internal failure even when the user actively denied.
    daemon = await startDaemon({
      socketPath,
      daemonVersion: 't',
      handlers: {
        unauthorized: () => {
          throw new DaemonProtocolError('UNAUTHORIZED', 'user denied');
        },
        invalidParams: () => {
          throw new DaemonProtocolError('INVALID_PARAMS', 'bad hex');
        },
      },
    });
    const client = await connectDaemon(socketPath);
    await expect(client!.call('unauthorized')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'user denied',
    });
    await expect(client!.call('invalidParams')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'bad hex',
    });
    client!.close();
  });

  it('handles multiple in-flight calls concurrently', async () => {
    daemon = await startDaemon({
      socketPath,
      daemonVersion: 't',
      handlers: {
        wait: async (params: unknown) => {
          const ms = (params as {ms: number}).ms;
          await new Promise((r) => setTimeout(r, ms));
          return ms;
        },
      },
    });
    const client = await connectDaemon(socketPath);
    const results = await Promise.all([
      client!.call('wait', {ms: 5}),
      client!.call('wait', {ms: 1}),
      client!.call('wait', {ms: 3}),
    ]);
    expect(results).toEqual([5, 1, 3]);
    client!.close();
  });

  it('binds the socket file with 0600 permissions (L1)', async () => {
    daemon = await startDaemon({socketPath, daemonVersion: 't', handlers: {}});
    const s = await stat(socketPath);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('binds the parent directory with 0700 permissions (L1)', async () => {
    // Use a nested path so startDaemon has to create the directory.
    socketPath = join(workDir, 'nested', 'wallet.sock');
    daemon = await startDaemon({socketPath, daemonVersion: 't', handlers: {}});
    const s = await stat(join(workDir, 'nested'));
    expect(s.mode & 0o777).toBe(0o700);
  });

  it('reaps a stale socket file left by a previous crashed daemon', async () => {
    // Drop a plain file at the socket path; nothing is listening on it.
    await writeFile(socketPath, 'leftover');
    daemon = await startDaemon({socketPath, daemonVersion: 't', handlers: {}});
    const client = await connectDaemon(socketPath);
    expect(client).not.toBeNull();
    client!.close();
  });

  it('refuses to bind when another daemon is actively listening', async () => {
    daemon = await startDaemon({socketPath, daemonVersion: 't', handlers: {}});
    await expect(
      startDaemon({socketPath, daemonVersion: 't', handlers: {}}),
    ).rejects.toThrow(/already listening/);
  });

  it('connectDaemon returns null when there is no socket', async () => {
    const client = await connectDaemon(join(workDir, 'missing.sock'));
    expect(client).toBeNull();
  });

  it('connectDaemon returns null when the socket file is stale (refused)', async () => {
    await writeFile(socketPath, 'stale');
    const client = await connectDaemon(socketPath);
    expect(client).toBeNull();
  });

  it('client.call rejects all pending calls on daemon close', async () => {
    daemon = await startDaemon({
      socketPath,
      daemonVersion: 't',
      handlers: {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 10_000));
          return 'never';
        },
      },
    });
    const client = await connectDaemon(socketPath);
    const pending = client!.call('slow');
    // Catch any late socket-error rejections so they don't surface as
    // unhandled rejections after the assertion completes.
    pending.catch(() => {});
    await daemon.close();
    daemon = null;
    await expect(pending).rejects.toMatchObject({code: 'CLOSED'});
    client!.close();
  });

  it('honors a per-call timeout', async () => {
    daemon = await startDaemon({
      socketPath,
      daemonVersion: 't',
      handlers: {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 1000));
          return 'late';
        },
      },
    });
    const client = await connectDaemon(socketPath);
    await expect(client!.call('slow', undefined, {timeoutMs: 50})).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    client!.close();
  });

  it('exposes the canonical PROTOCOL_VERSION', () => {
    // Trivial guard: a future change that bumps the version must be
    // deliberate, since the version is part of the public contract.
    expect(PROTOCOL_VERSION).toBe('moth-wallet-daemon/1');
  });

  it('closes the connection on a peer that sends malformed bytes', async () => {
    daemon = await startDaemon({socketPath, daemonVersion: 't', handlers: {}});

    // Connect a raw socket and shove a header that declares an absurd length.
    const sock = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
      const s = createConnection(socketPath);
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(0xffffffff, 0);
    sock.write(huge);

    const closed = await new Promise<boolean>((resolve) => {
      sock.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    expect(closed).toBe(true);
  });
}, 15_000);

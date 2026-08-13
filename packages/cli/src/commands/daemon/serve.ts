// Headless wallet daemon — same socket protocol the TUI hosts, but no
// Ink renderer in front of it. Used by integration tests and by the
// future Web2 service deployment. The wallet is unlocked from
// MOTH_PASSPHRASE and the daemon stays alive until SIGINT/SIGTERM.
//
// L3 (human-in-the-loop confirmation) is not meaningful in headless
// mode — there's no user to answer the modal. The command therefore
// requires `--auto-approve` AND `MOTH_DAEMON_AUTO_APPROVE=1` together,
// belt-and-suspenders, to make it inarguable that the operator
// understood there's no consent gate. Every auto-approval is logged.
//
// The verb handler bodies live in core (buildWalletHandlers); this
// command just wires the unlocked wallet + sync into the dependency
// bundle and owns the process lifecycle.

import {Flags} from '@oclif/core';
import {
  startDaemon,
  daemonSocketPath,
  ConfirmationQueue,
  startWalletSync,
  buildWalletHandlers,
  AuditLog,
  ApiKeyStore,
  type DaemonHandle,
  type SyncedWallet,
  type WalletBalances,
  type AuthHandler,
} from '@shieldedtech/moth-wallet';
import {BaseCommand} from '../../base-command.js';
import {getPassphrase} from '../../adapters/passphrase.js';

const DAEMON_VERSION = '0.1.0';
const AUTO_APPROVE_ENV = 'MOTH_DAEMON_AUTO_APPROVE';

export default class DaemonServe extends BaseCommand {
  static override description =
    'Start a headless wallet daemon hosting the same RPC verbs the TUI exposes. Used by integration tests and by service-mode deployments. Requires the wallet passphrase via MOTH_PASSPHRASE; runs until SIGINT/SIGTERM.';

  static override flags = {
    ...BaseCommand.baseFlags,
    'auto-approve': Flags.boolean({
      description:
        `Auto-approve every L3 confirmation modal. REQUIRED in headless mode because there is no human to answer modals. Must also set the ${AUTO_APPROVE_ENV}=1 environment variable to make consent loss explicit.`,
      default: false,
    }),
    'max-spend': Flags.string({
      description:
        'Per-transaction NIGHT spend cap enforced under --auto-approve. Any NIGHT transfer above this amount is refused, bounding blast radius when there is no human to approve. REQUIRED with --auto-approve. Example: --max-spend 100 (NIGHT).',
    }),
    'idle-timeout': Flags.integer({
      description:
        'Minutes of client inactivity after which the daemon locks the wallet (drops keys from memory) and exits, matching the extension\'s auto-lock. Set 0 to disable for always-on service deployments. Default 15.',
      default: 15,
    }),
    'wait-for-sync': Flags.boolean({
      description: 'Block until the wallet reports synced=true before binding the socket. Useful in tests.',
      default: true,
      allowNo: true,
    }),
    transport: Flags.string({
      description:
        'Transport to bind. `unix` (default) uses ~/.moth/sync/<network>/<wallet>.sock with 0600 perms. `tcp` exposes the same JSON-RPC frames over a TCP listener — combine with --bind to set the host:port. Stage-2 deployments behind a reverse proxy or in a private network use tcp.',
      options: ['unix', 'tcp'],
      default: 'unix',
    }),
    bind: Flags.string({
      description:
        'TCP bind address in <host>:<port> form (e.g. 127.0.0.1:8765). Required when --transport tcp. Loopback only — the daemon refuses to bind a non-loopback host because the transport is unencrypted. For remote access, put a reverse proxy that terminates TLS in front of a loopback bind. TCP also requires at least one active API key in ~/.moth/api-keys/ — generate one with `moth daemon key gen --label "<purpose>"` first.',
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(DaemonServe);
    this.outputFormat = (flags.output as 'text' | 'json') ?? 'text';
    this.verbose = flags.verbose;

    if (!flags['auto-approve']) {
      this.outputError(
        'INVALID_INPUT',
        `Headless serve mode has no human to answer L3 modals. Pass --auto-approve AND set ${AUTO_APPROVE_ENV}=1 to acknowledge that approval is automated.`,
      );
      this.exit(2);
      return;
    }
    if (process.env[AUTO_APPROVE_ENV] !== '1') {
      this.outputError(
        'INVALID_INPUT',
        `${AUTO_APPROVE_ENV}=1 environment variable is required alongside --auto-approve. Belt-and-suspenders so a stray flag in a shell history doesn't disable consent on prod.`,
      );
      this.exit(2);
      return;
    }

    // With no human to approve L3 modals, an unbounded auto-approve daemon
    // would move any amount on request. Require an explicit per-tx NIGHT cap
    // so the blast radius is bounded; enforced in the transferTokens handler.
    if (!flags['max-spend']) {
      this.outputError(
        'INVALID_INPUT',
        '--max-spend <NIGHT> is required with --auto-approve: it caps the NIGHT any single transfer can move without a human in the loop.',
      );
      this.exit(2);
      return;
    }
    const maxSpendRaw = parseNightToRaw(flags['max-spend']);
    if (maxSpendRaw === null || maxSpendRaw <= 0n) {
      this.outputError(
        'INVALID_INPUT',
        `--max-spend must be a positive NIGHT amount (up to 6 decimals); got "${flags['max-spend']}".`,
      );
      this.exit(2);
      return;
    }

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));
    const passphrase = await getPassphrase();

    // Persistent audit log at ~/.moth/daemon-audit.log. Captures
    // every RPC's verb / summary / decision / outcome plus daemon
    // lifecycle events. Survives the daemon process — the next stage
    // (TCP transport + API-key AuthN) will key its policy decisions
    // on this same record.
    const auditLog = new AuditLog();
    auditLog.recordLifecycle({
      wallet: walletName,
      network: network.id,
      event: 'daemon-start',
      message: `PID ${process.pid}`,
    });

    process.stderr.write(`[daemon-serve] unlocking wallet "${walletName}" on ${network.id}\n`);
    const unlocked = await this.walletManager.unlock(walletName, passphrase);

    // The typed key bundle built at unlock time. Write verbs read this;
    // the raw seedHex was dropped inside walletManager.unlock and is
    // never exposed (D-KM-3).
    const walletKeys = unlocked.walletKeys;

    process.stderr.write('[daemon-serve] starting wallet sync\n');
    const synced: SyncedWallet = await startWalletSync(
      walletKeys,
      network,
      (msg) => this.log_verbose(`[sync] ${msg}`),
      walletName,
    );

    if (flags['wait-for-sync']) {
      process.stderr.write('[daemon-serve] waiting for wallet to report synced=true\n');
      await waitForSynced(synced);
      process.stderr.write('[daemon-serve] wallet synced\n');
      auditLog.recordLifecycle({wallet: walletName, network: network.id, event: 'sync-complete'});
    }

    // Auto-approving queue — log every grant for audit.
    const queue = new ConfirmationQueue({
      autoApprove: true,
      onAutoApprove: (req) => {
        process.stderr.write(`[daemon-serve auto-approve] ${req.summary}\n`);
        for (const d of req.details ?? []) {
          process.stderr.write(`[daemon-serve auto-approve]   · ${d}\n`);
        }
      },
    });

    const handlers = buildWalletHandlers({
      walletName,
      network,
      getFacade: () => synced.facade,
      getWalletKeys: () => walletKeys,
      getBalances: () => synced.balances,
      queue,
      auditLog,
      maxSpendRaw,
      log: (level, msg) => {
        if (level === 'info') this.log_verbose(`[daemon] ${msg}`);
        else process.stderr.write(`[daemon ${level}] ${msg}\n`);
      },
    });

    let bind;
    if (flags.transport === 'tcp') {
      if (!flags.bind) {
        this.outputError(
          'INVALID_INPUT',
          '--bind <host>:<port> is required when --transport tcp',
        );
        this.exit(2);
        return;
      }
      const sep = flags.bind.lastIndexOf(':');
      if (sep <= 0) {
        this.outputError(
          'INVALID_INPUT',
          `--bind must be <host>:<port>; got "${flags.bind}"`,
        );
        this.exit(2);
        return;
      }
      const host = flags.bind.slice(0, sep);
      const port = Number.parseInt(flags.bind.slice(sep + 1), 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        this.outputError(
          'INVALID_INPUT',
          `--bind port must be an integer in [1, 65535]; got "${flags.bind.slice(sep + 1)}"`,
        );
        this.exit(2);
        return;
      }
      // Loopback only: the TCP transport is unencrypted, so binding a
      // routable interface (0.0.0.0 or a LAN/public IP) would expose
      // transfers and tokens in cleartext. Remote deployments front a
      // loopback bind with a reverse proxy that terminates TLS.
      const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
      if (!LOOPBACK_HOSTS.has(host)) {
        this.outputError(
          'INVALID_INPUT',
          `Refusing to bind "${host}": the daemon binds loopback only (127.0.0.1, ::1, localhost). The TCP transport is unencrypted — for remote access, put a reverse proxy terminating TLS in front of a loopback bind rather than binding a routable interface.`,
        );
        this.exit(2);
        return;
      }
      bind = {transport: 'tcp', host, port} as const;
    } else {
      bind = {transport: 'unix', socketPath: daemonSocketPath(network.id, walletName)} as const;
    }

    // Stage-2 AuthN policy:
    //   - TCP transport REQUIRES an auth handler. Without an
    //     ApiKeyStore with at least one active key, refuse to bind.
    //   - Unix transport runs unauthenticated by default (kernel UID
    //     is sufficient on the 0600 socket). Operators can still opt
    //     into key-based auth on Unix for parity with TCP if they
    //     want — that's `--require-auth` (future), not the default.
    let authHandler: AuthHandler | undefined;
    if (bind.transport === 'tcp') {
      const store = new ApiKeyStore();
      if (!store.hasActiveKey()) {
        this.outputError(
          'INVALID_INPUT',
          `Refusing to bind ${bind.host}:${bind.port}: TCP transport requires at least one active API key. Generate one with \`moth daemon key gen --label "<purpose>"\`, capture the printed token (shown ONCE), and start the daemon again. Loopback bind (127.0.0.1, ::1, localhost) is also fine if you want unauthenticated localhost-only access — use --transport unix instead.`,
        );
        this.exit(2);
        return;
      }
      authHandler = (token) => store.verify(token);
    }

    // Idle auto-lock: reset on any client activity; a watchdog below
    // locks + exits once inactivity exceeds the timeout. 0 disables it.
    const idleMs = flags['idle-timeout'] > 0 ? flags['idle-timeout'] * 60_000 : 0;
    let lastActivity = Date.now();

    const handle: DaemonHandle = await startDaemon({
      bind,
      daemonVersion: DAEMON_VERSION,
      handlers,
      auth: authHandler,
      onActivity: () => {
        lastActivity = Date.now();
      },
      // Permanent trail of authentication attempts (#11) — the live log
      // alone left no record of break-in attempts.
      onAuthEvent: (e) =>
        auditLog.recordLifecycle({
          wallet: walletName,
          network: network.id,
          event: e.outcome === 'success' ? 'auth-success' : 'auth-failure',
          apiKeyId: e.apiKeyId,
          message: e.peer ? `peer ${e.peer}` : undefined,
        }),
      onLog: (level, msg) => process.stderr.write(`[daemon ${level}] ${msg}\n`),
    });
    process.stderr.write(`[daemon-serve] listening at ${handle.listenAddress}\n`);
    process.stderr.write(`[daemon-serve] PID ${process.pid}; SIGINT/SIGTERM to stop\n`);
    auditLog.recordLifecycle({
      wallet: walletName,
      network: network.id,
      event: 'socket-bound',
      message: handle.listenAddress,
    });

    let shuttingDown = false;
    const shutdown = async (reason: NodeJS.Signals | 'idle-timeout') => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`\n[daemon-serve] ${reason === 'idle-timeout' ? 'idle timeout reached' : `received ${reason}`}, shutting down\n`);
      auditLog.recordLifecycle({
        wallet: walletName,
        network: network.id,
        event: 'shutdown-signal',
        message: reason,
      });
      // Order: stop accepting clients first so no in-flight RPC tries
      // to read seedHex after lock() zeros it. Then stop the sync.
      // Then lock the wallet, clearing the seed from memory.
      await handle.close().catch((err) => {
        process.stderr.write(`[daemon-serve] handle.close error: ${err}\n`);
      });
      await synced.stop().catch((err) => {
        process.stderr.write(`[daemon-serve] synced.stop error: ${err}\n`);
      });
      try {
        unlocked.lock();
      } catch (err) {
        process.stderr.write(`[daemon-serve] wallet lock error: ${err}\n`);
      }
      auditLog.recordLifecycle({wallet: walletName, network: network.id, event: 'daemon-stop'});
      process.stderr.write('[daemon-serve] stopped\n');
      // Exit cleanly past oclif's catch chain.
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    if (idleMs > 0) {
      process.stderr.write(`[daemon-serve] idle auto-lock after ${flags['idle-timeout']} min of inactivity\n`);
    }

    // Hold the event loop open until shutdown; also the idle watchdog.
    await new Promise<void>((resolveOuter) => {
      const tick = setInterval(() => {
        if (shuttingDown) {
          clearInterval(tick);
          resolveOuter();
          return;
        }
        if (idleMs > 0 && Date.now() - lastActivity > idleMs) {
          void shutdown('idle-timeout');
        }
      }, 1000);
    });
  }
}

/** Parse a decimal NIGHT amount (up to 6 dp) to raw base units, or null if
 *  malformed. NIGHT has 6 decimals (see NIGHT_DENOMINATION). */
function parseNightToRaw(input: string): bigint | null {
  const m = input.trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(6, '0');
  return BigInt(m[1]) * 1_000_000n + BigInt(frac);
}

async function waitForSynced(synced: SyncedWallet): Promise<void> {
  return new Promise<void>((resolveOuter) => {
    if (synced.balances.synced) return resolveOuter();
    const unsub = synced.subscribe((b: WalletBalances) => {
      if (b.synced) {
        unsub();
        resolveOuter();
      }
    });
  });
}

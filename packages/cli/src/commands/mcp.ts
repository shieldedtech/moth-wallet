// MCP stdio server around the wallet core — the agent-facing sibling of
// `moth daemon serve`. Same shape: the verb bodies live in core
// (buildWalletHandlers); this command wires the unlocked wallet + sync
// into the dependency bundle and owns the process lifecycle. The
// difference is the wire: MCP JSON-RPC over stdio instead of framed
// JSON-RPC over a socket.
//
// stdout is the protocol channel. Nothing else may ever reach it — all
// logging goes to stderr, and guardStdout() reroutes any stray writer
// (SDK loggers, console.log) before the wallet engine starts.
//
// Consent model matches the daemon: read tools are always served;
// spend tools require --auto-approve AND MOTH_DAEMON_AUTO_APPROVE=1
// (belt-and-suspenders) AND a mandatory --max-spend NIGHT cap. Every
// auto-approved spend is written to ~/.moth/daemon-audit.log.
//
// The MCP handshake must complete within the client's spawn timeout,
// but a first wallet sync can take minutes — so the transport connects
// immediately after unlock and the sync runs in the background. Agents
// use the wait_for_sync tool as an explicit barrier.

import {Flags} from '@oclif/core';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  AuditLog,
  ConfirmationQueue,
  buildWalletHandlers,
  parseNightAmount,
  startWalletSync,
  type SyncedWallet,
} from '@shieldedtech/moth-wallet';
import {BaseCommand} from '../base-command.js';
import {guardStdout} from '../mcp/stdout-guard.js';
import {createWalletRuntime} from '../mcp/runtime.js';
import {buildMcpServer} from '../mcp/server.js';
import {startMcpHttpServer} from '../mcp/http-transport.js';

const AUTO_APPROVE_ENV = 'MOTH_DAEMON_AUTO_APPROVE';

// Same rule as `daemon serve --transport tcp`: the HTTP transport is
// unencrypted and unauthenticated, so only loopback binds are accepted.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export default class Mcp extends BaseCommand {
  static override description =
    'Start an MCP (Model Context Protocol) server exposing this wallet to AI agents. ' +
    'Default transport is stdio (the MCP client spawns this command); --transport http binds a loopback URL instead, ' +
    'so you run the server yourself and any number of clients connect to http://<bind>/mcp. ' +
    'Read tools (status, balances, addresses, activity, wallet list, wait_for_sync) are always served. ' +
    `Spend tools (transfer, fee estimate, dust register/deregister) require --auto-approve plus ${AUTO_APPROVE_ENV}=1 plus --max-spend. ` +
    'Requires the wallet passphrase via MOTH_PASSPHRASE (stdin is the protocol channel in stdio mode, so no prompt is possible). ' +
    'Runs until the client disconnects (stdio), or SIGINT/SIGTERM. ' +
    'Stdio client config: {"command": "moth", "args": ["mcp", "--wallet", "<name>"], "env": {"MOTH_PASSPHRASE": "..."}}.';

  static override flags = {
    ...BaseCommand.baseFlags,
    transport: Flags.string({
      description:
        'Transport to serve MCP on. `stdio` (default) speaks JSON-RPC over this process\'s stdin/stdout — the MCP client owns the process. `http` binds the MCP Streamable HTTP endpoint at http://<bind>/mcp — you own the process and clients connect by URL; combine with --bind.',
      options: ['stdio', 'http'],
      default: 'stdio',
    }),
    bind: Flags.string({
      description:
        'HTTP bind address as <host>:<port> (e.g. 127.0.0.1:8765), required with --transport http. Loopback only — the transport is unencrypted and unauthenticated, so a non-loopback host is refused. Port 0 picks a free port (printed on stderr).',
    }),
    'auto-approve': Flags.boolean({
      description:
        `Enable spend tools by auto-approving every L3 confirmation — there is no human at an MCP server to answer modals. Must also set the ${AUTO_APPROVE_ENV}=1 environment variable to make consent loss explicit, and --max-spend to bound it. Without this flag the server is read-only.`,
      default: false,
    }),
    'max-spend': Flags.string({
      description:
        'Per-transaction NIGHT spend cap enforced under --auto-approve. Any NIGHT transfer above this amount is refused, bounding blast radius when there is no human to approve. REQUIRED with --auto-approve. Example: --max-spend 100 (NIGHT).',
    }),
    'allow-balancing': Flags.boolean({
      description:
        'Additionally expose the balance_transaction and submit_transaction tools: balance, prove, sign, and submit externally-built transactions — the dApp-connector flow (e.g. a site-generated payment tx, proven by the wallet when the dApp cannot). WARNING: the value such transactions move is opaque to the wallet, so --max-spend CANNOT cap them; the wallet will fund whatever the transaction needs, bounded only by its balance. Requires the full --auto-approve consent gate. Every use is audited.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const {flags} = await this.parse(Mcp);
    this.verbose = flags.verbose;
    // NOTE: never call this.log/outputSuccess in this command — they
    // write stdout, which belongs to the MCP transport.

    // ── Consent gate (fail fast, before any transport exists) ────────
    let maxSpendRaw: bigint | undefined;
    if (flags['auto-approve']) {
      if (process.env[AUTO_APPROVE_ENV] !== '1') {
        this.outputError(
          'INVALID_INPUT',
          `${AUTO_APPROVE_ENV}=1 environment variable is required alongside --auto-approve. Belt-and-suspenders so a stray flag in a shell history doesn't disable consent on prod.`,
        );
        this.exit(2);
        return;
      }
      if (!flags['max-spend']) {
        this.outputError(
          'INVALID_INPUT',
          '--max-spend <NIGHT> is required with --auto-approve: it caps the NIGHT any single transfer can move without a human in the loop.',
        );
        this.exit(2);
        return;
      }
      try {
        maxSpendRaw = parseNightAmount(flags['max-spend']);
      } catch {
        this.outputError(
          'INVALID_INPUT',
          `--max-spend must be a positive NIGHT amount (up to 6 decimals); got "${flags['max-spend']}".`,
        );
        this.exit(2);
        return;
      }
    }
    // Balancing is an escalation OF spending (uncapped by design — the
    // amounts inside externally-built transaction bytes are opaque), so
    // it never arms without the full spend consent gate underneath it.
    if (flags['allow-balancing'] && !flags['auto-approve']) {
      this.outputError(
        'INVALID_INPUT',
        '--allow-balancing requires the full spend consent gate: --auto-approve, MOTH_DAEMON_AUTO_APPROVE=1, and --max-spend. Balancing signs externally-built transactions whose value the --max-spend cap cannot see.',
      );
      this.exit(2);
      return;
    }

    // ── Passphrase: env only — stdin is the JSON-RPC channel ─────────
    const passphrase = process.env.MOTH_PASSPHRASE;
    if (!passphrase) {
      this.outputError(
        'INVALID_INPUT',
        'MOTH_PASSPHRASE is required: MCP mode cannot prompt for a passphrase because stdin is the protocol channel. Set it in the MCP client\'s env config.',
      );
      this.exit(2);
      return;
    }

    // ── HTTP bind validation (fail fast, before unlock) ──────────────
    const transportKind = flags.transport as 'stdio' | 'http';
    let bindHost = '';
    let bindPort = 0;
    if (transportKind === 'http') {
      if (!flags.bind) {
        this.outputError('INVALID_INPUT', '--bind <host>:<port> is required when --transport http');
        this.exit(2);
        return;
      }
      const sep = flags.bind.lastIndexOf(':');
      if (sep <= 0) {
        this.outputError('INVALID_INPUT', `--bind must be <host>:<port>; got "${flags.bind}"`);
        this.exit(2);
        return;
      }
      bindHost = flags.bind.slice(0, sep);
      bindPort = Number.parseInt(flags.bind.slice(sep + 1), 10);
      if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
        this.outputError(
          'INVALID_INPUT',
          `--bind port must be an integer in [0, 65535] (0 picks a free port); got "${flags.bind.slice(sep + 1)}"`,
        );
        this.exit(2);
        return;
      }
      if (!LOOPBACK_HOSTS.has(bindHost)) {
        this.outputError(
          'INVALID_INPUT',
          `Refusing to bind "${bindHost}": the MCP HTTP transport binds loopback only (127.0.0.1, ::1, localhost). It is unencrypted and unauthenticated — for remote access, front a loopback bind with a TLS-terminating reverse proxy that adds authentication.`,
        );
        this.exit(2);
        return;
      }
    }

    const walletName = await this.resolveWalletName(flags);
    const network = await this.getNetworkConfig(flags.network, this.getNetworkOverrides(flags));

    // Same persistent audit log the daemon writes (~/.moth/daemon-audit.log);
    // lifecycle messages are tagged mcp-stdio to tell the hosts apart.
    const auditLog = new AuditLog();
    auditLog.recordLifecycle({
      wallet: walletName,
      network: network.id,
      event: 'daemon-start',
      message: `mcp-stdio PID ${process.pid}`,
    });

    // stdio mode: claim stdout for the transport before the wallet
    // engine (and its chatty dependencies) load — everything else now
    // lands on stderr. In http mode stdout carries no protocol, so no
    // guard is needed.
    const rawStdout = transportKind === 'stdio' ? guardStdout() : null;

    process.stderr.write(`[mcp] unlocking wallet "${walletName}" on ${network.id}\n`);
    const unlocked = await this.walletManager.unlock(walletName, passphrase);

    const runtime = createWalletRuntime({
      walletName,
      network,
      unlocked,
      onFirstSynced: () => {
        process.stderr.write('[mcp] wallet synced\n');
        auditLog.recordLifecycle({wallet: walletName, network: network.id, event: 'sync-complete'});
      },
    });

    // Auto-approving queue — only reachable through spend tools, which
    // are only registered when the consent gate above passed. Every
    // grant is logged for audit, same as daemon serve.
    const queue = new ConfirmationQueue({
      autoApprove: true,
      onAutoApprove: (req) => {
        process.stderr.write(`[mcp auto-approve] ${req.summary}\n`);
        for (const d of req.details ?? []) {
          process.stderr.write(`[mcp auto-approve]   · ${d}\n`);
        }
      },
    });

    runtime.handlers = buildWalletHandlers({
      walletName,
      network,
      getFacade: () => runtime.getFacade(),
      getWalletKeys: () => runtime.getWalletKeys(),
      getBalances: () => runtime.getBalances(),
      queue,
      auditLog,
      maxSpendRaw,
      log: (level, msg) => {
        if (level === 'info') this.log_verbose(`[mcp] ${msg}`);
        else process.stderr.write(`[mcp ${level}] ${msg}\n`);
      },
    });

    const serverDeps = {
      runtime,
      walletManager: this.walletManager,
      version: this.config.version,
      spend: maxSpendRaw !== undefined
        ? {maxSpendRaw, allowBalancing: flags['allow-balancing']}
        : undefined,
    };

    // ── Shutdown (idempotent). Order matters: stop accepting tool
    // calls first so no in-flight handler reads keys after lock()
    // zeros them, then stop the sync, then lock the wallet. ──────────
    let shuttingDown = false;
    let synced: SyncedWallet | null = null;
    let closeFrontend: () => Promise<void> = async () => {};
    const shutdown = async (reason: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`\n[mcp] ${reason}, shutting down\n`);
      auditLog.recordLifecycle({
        wallet: walletName,
        network: network.id,
        event: 'shutdown-signal',
        message: `mcp-${transportKind} ${reason}`,
      });
      await closeFrontend().catch((err) => {
        process.stderr.write(`[mcp] transport close error: ${err}\n`);
      });
      await synced?.stop().catch((err) => {
        process.stderr.write(`[mcp] synced.stop error: ${err}\n`);
      });
      try {
        unlocked.lock();
      } catch (err) {
        process.stderr.write(`[mcp] wallet lock error: ${err}\n`);
      }
      auditLog.recordLifecycle({wallet: walletName, network: network.id, event: 'daemon-stop'});
      process.stderr.write('[mcp] stopped\n');
      // Exit cleanly past oclif's catch chain; leftover WS handles
      // would otherwise hold the event loop open.
      process.exit(0);
    };

    if (transportKind === 'http') {
      // Operator-run mode: any number of MCP clients connect by URL;
      // the process lives until SIGINT/SIGTERM. One McpServer per
      // session, all sharing this runtime and its handlers.
      const httpHandle = await startMcpHttpServer({
        host: bindHost,
        port: bindPort,
        createMcpServer: () => buildMcpServer(serverDeps),
        log: (msg) => process.stderr.write(`[mcp http] ${msg}\n`),
      });
      closeFrontend = httpHandle.close;
      process.stderr.write(`[mcp] listening at ${httpHandle.url}\n`);
      process.stderr.write(
        `[mcp] serving wallet "${walletName}" on ${network.id} over http` +
        `${maxSpendRaw !== undefined ? ' (spend tools enabled)' : ' (read-only: spend tools not registered)'}\n`,
      );
      process.stderr.write(`[mcp] PID ${process.pid}; SIGINT/SIGTERM to stop\n`);
    } else {
      if (!rawStdout) throw new Error('unreachable: stdout guard not installed in stdio mode');
      const server = buildMcpServer(serverDeps);
      const transport = new StdioServerTransport(process.stdin, rawStdout);
      await server.connect(transport);
      closeFrontend = () => server.close();
      // connect() takes over transport.onclose — hook the protocol-level
      // close instead (covers explicit closes and transport errors).
      server.server.onclose = () => void shutdown('transport closed');
      // The SDK transport never watches for stdin EOF (it only listens
      // for 'data'/'error'), so a client that exits without killing us
      // would leak an unlocked wallet. Watch EOF ourselves — measured:
      // without this, the process outlives the client indefinitely.
      // (stdio mode only: a backgrounded http server sees EOF at once.)
      process.stdin.on('end', () => void shutdown('stdin closed (client exited)'));
      process.stdin.on('close', () => void shutdown('stdin closed (client exited)'));

      process.stderr.write(
        `[mcp] serving wallet "${walletName}" on ${network.id} over stdio` +
        `${maxSpendRaw !== undefined ? ' (spend tools enabled)' : ' (read-only: spend tools not registered)'}\n`,
      );
      process.stderr.write(`[mcp] PID ${process.pid}; client disconnect or SIGINT/SIGTERM to stop\n`);
    }

    process.on('SIGINT', () => void shutdown('received SIGINT'));
    process.on('SIGTERM', () => void shutdown('received SIGTERM'));

    // ── Background sync: never block the MCP handshake on a
    // minutes-long first sync. Tools report syncState until ready. ───
    void (async () => {
      try {
        process.stderr.write('[mcp] starting wallet sync\n');
        const s = await startWalletSync(
          unlocked.walletKeys,
          network,
          (msg) => this.log_verbose(`[sync] ${msg}`),
          walletName,
        );
        if (shuttingDown) {
          await s.stop().catch(() => {});
          return;
        }
        synced = s;
        runtime.attachSynced(s);
        process.stderr.write('[mcp] wallet engine ready (sync continuing in background)\n');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runtime.markFailed(msg);
        process.stderr.write(`[mcp] wallet sync failed: ${msg}\n`);
      }
    })();

    // Hold the event loop open until shutdown.
    await new Promise<void>((resolveOuter) => {
      const tick = setInterval(() => {
        if (shuttingDown) {
          clearInterval(tick);
          resolveOuter();
        }
      }, 1000);
    });
  }
}

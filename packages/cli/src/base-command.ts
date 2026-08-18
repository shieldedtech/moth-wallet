import { Command, Flags, Errors as OclifErrors } from '@oclif/core';
import { access } from 'node:fs/promises';
import type { OutputFormat } from './formatters/index.js';
import { formatOutput, formatError } from './formatters/index.js';
import {
  WalletError,
  type WalletErrorCategory,
  WalletManager,
  DEFAULT_NETWORKS,
  type NetworkConfig,
  resolveProverConfig,
  serverProver,
  validateNetworkConfig,
  connectDaemon,
  connectDaemonTcp,
  daemonSocketPath,
  type DaemonClient,
} from '@shieldedtech/moth-wallet';
import { FilesystemStorageAdapter, initSdk, resolveLedgerVersion } from '@shieldedtech/moth-wallet';

/**
 * Why a daemon connect failed. Distinguishes the cases the user needs to
 * see different remediation hints for.
 */
type DaemonConnectFailure =
  | 'no-tui'              // Unix socket file absent
  | 'stale-socket'        // Unix socket file exists but nothing is listening
  | 'tcp-refused'         // TCP connect refused (nothing listening on the port)
  | 'auth-failed'         // TCP daemon rejected the token
  | 'handshake-failed';   // protocol-version mismatch or hello timed out

export interface DaemonConnectResult {
  readonly client: DaemonClient | null;
  readonly failure: DaemonConnectFailure | null;
  /** Operator-friendly label of where we tried to connect:
   *  `unix:///Users/.../wallet.sock` or `tcp://host:port`. */
  readonly target: string;
  /** Legacy field — Unix socket path when the connect was a Unix
   *  attempt, empty string otherwise. Kept so callers reading
   *  `.socketPath` keep working. */
  readonly socketPath: string;
}

/** Options the daemon-connect helpers accept. Maps 1:1 to the flag
 *  set below; pulled out so subcommands can build the options object
 *  from their parsed flags without typing it inline. */
export interface DaemonClientOpts {
  readonly bind?: string;
}

/** Split a `host:port` string into typed parts, or null if malformed.
 *  Used by the TCP path of probeDaemon. */
function parseBindString(bind: string): {host: string; port: number} | null {
  const sep = bind.lastIndexOf(':');
  if (sep <= 0) return null;
  const host = bind.slice(0, sep);
  const port = Number.parseInt(bind.slice(sep + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {host, port};
}

/**
 * Flag set every daemon-mode subcommand mixes in. Lets the operator
 * point at either:
 *   - the default Unix daemon for `(network, walletName)` (no flags)
 *   - a TCP daemon at `--bind host:port`, with the API token supplied
 *     ONLY via the `MOTH_DAEMON_TOKEN` environment variable (never a CLI
 *     flag — a flag value is readable from the process list)
 */
export const daemonClientFlags = {
  bind: Flags.string({
    description: 'TCP daemon target as `<host>:<port>` (e.g. 127.0.0.1:18820). When set, the subcommand connects via TCP and requires the API token in the MOTH_DAEMON_TOKEN environment variable. When omitted, the subcommand uses the Unix socket for the active wallet.',
  }),
} as const;

// Load .env file if present (won't override existing env vars)
import 'dotenv/config';

// Patterns that indicate sensitive data — never log these
const SENSITIVE_PATTERNS = [
  /\b[a-f0-9]{64}\b/gi,
  /\b(?:abandon\s+){11}\w+\b/gi,
  /\bmnemonic\s*[:=]\s*\S+/gi,
  /\bpassphrase\s*[:=]\s*\S+/gi,
  /\bprivate[_-]?key\s*[:=]\s*\S+/gi,
];

function sanitizeForLogging(message: string): string {
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

export abstract class BaseCommand extends Command {
  static baseFlags = {
    output: Flags.string({
      char: 'o',
      options: ['text', 'json'] as const,
      default: 'text',
      description: 'Output format',
    }),
    network: Flags.string({
      char: 'n',
      default: 'devnet',
      description: 'Target network',
    }),
    wallet: Flags.string({
      char: 'w',
      description: 'Wallet name (default: active wallet)',
    }),
    verbose: Flags.boolean({
      char: 'v',
      default: false,
      description: 'Debug output to stderr',
    }),
    timeout: Flags.integer({
      char: 't',
      description: 'Operation timeout in seconds',
    }),
    'proof-server': Flags.string({
      description: 'Proof server URL override',
    }),
    prover: Flags.string({
      options: ['server', 'wasm'],
      description: 'Proof generation mode',
      env: 'MOTH_PROVER',
    }),
    indexer: Flags.string({
      description: 'Indexer GraphQL URL override',
      env: 'MOTH_INDEXER_URL',
    }),
    'node-url': Flags.string({
      description: 'Node WebSocket URL override',
      env: 'MOTH_NODE_URL',
    }),
  };

  protected outputFormat: OutputFormat = 'text';
  protected verbose = false;

  private _storage?: FilesystemStorageAdapter;
  private _walletManager?: WalletManager;

  async init(): Promise<void> {
    await super.init();
    // Best-effort matrix check — only runs if enabled via config
    await this.checkSupportMatrix();
  }

  protected get storage(): FilesystemStorageAdapter {
    if (!this._storage) {
      this._storage = new FilesystemStorageAdapter();
    }
    return this._storage;
  }

  protected get walletManager(): WalletManager {
    if (!this._walletManager) {
      this._walletManager = new WalletManager(this.storage);
    }
    return this._walletManager;
  }

  /**
   * Resolve network config with overrides.
   *
   * Precedence (highest to lowest):
   * 1. CLI flags (--indexer, --node-url, --prover, --proof-server)
   * 2. Environment variables (MOTH_INDEXER_URL, MOTH_NODE_URL, MOTH_PROVER, MOTH_PROOF_SERVER_URL)
   * 3. .env file (loaded automatically via dotenv)
   * 4. Persisted config (moth config set indexer-url <url>)
   * 5. Network defaults (devnet, preview, preprod, qanet)
   */
  protected async getNetworkConfig(
    networkId: string,
    overrides?: {
      proofServer?: string;
      prover?: string;
      indexer?: string;
      nodeUrl?: string;
    },
  ): Promise<NetworkConfig> {
    // Block mainnet usage — this is a reference wallet
    if (networkId === 'mainnet') {
      process.stderr.write(
        '\n' +
        '  ╔══════════════════════════════════════════════════════════════╗\n' +
        '  ║                         WARNING                            ║\n' +
        '  ║                                                            ║\n' +
        '  ║  Moth is a reference wallet for development and testing.   ║\n' +
        '  ║  It should NOT be used with real funds on mainnet.         ║\n' +
        '  ║                                                            ║\n' +
        '  ║  Use Lace or another commercial wallet for mainnet.        ║\n' +
        '  ╚══════════════════════════════════════════════════════════════╝\n' +
        '\n',
      );
      this.exit(1);
    }

    const base = DEFAULT_NETWORKS[networkId] ?? {
      id: networkId,
      nodeUrl: 'ws://localhost:9944',
      indexerUrl: 'http://localhost:8088',
      prover: serverProver(),
    };

    // Check persisted config
    const decoder = new TextDecoder();
    const persistedIndexer = await this.storage.read('config/indexer-url').then(
      d => d ? decoder.decode(d) : null,
    ).catch(() => null);
    const persistedNode = await this.storage.read('config/node-url').then(
      d => d ? decoder.decode(d) : null,
    ).catch(() => null);
    const persistedProof = await this.storage.read('config/proof-server-url').then(
      d => d ? decoder.decode(d) : null,
    ).catch(() => null);
    const persistedProver = await this.storage.read('config/prover').then(
      d => d ? decoder.decode(d) : null,
    ).catch(() => null);

    const baseProver = resolveProverConfig(base);
    const proofServerUrl = overrides?.proofServer
      ?? process.env.MOTH_PROOF_SERVER_URL
      ?? persistedProof
      ?? (baseProver.type === 'server' ? baseProver.url : 'http://localhost:6300');
    const proverMode = overrides?.prover
      ?? process.env.MOTH_PROVER
      ?? persistedProver
      ?? baseProver.type;
    if (proverMode !== 'server' && proverMode !== 'wasm') {
      throw new WalletError('INVALID_INPUT', `Invalid prover mode "${proverMode}". Use "server" or "wasm".`);
    }

    const config: NetworkConfig = {
      id: networkId,
      indexerUrl: overrides?.indexer
        ?? process.env.MOTH_INDEXER_URL
        ?? persistedIndexer
        ?? base.indexerUrl,
      nodeUrl: overrides?.nodeUrl
        ?? process.env.MOTH_NODE_URL
        ?? persistedNode
        ?? base.nodeUrl,
      prover: proverMode === 'wasm' ? {type: 'wasm'} : serverProver(proofServerUrl),
      // Carried from the preset: dropping these would demote a v9 network to the
      // v8 default and lose the faucet endpoint.
      ...(base.ledgerVersion ? {ledgerVersion: base.ledgerVersion} : {}),
      ...(base.faucetUrl ? {faucetUrl: base.faucetUrl} : {}),
    };

    // CWE-918: Validate URL schemes to prevent SSRF via user-controlled URLs
    validateNetworkConfig(config);

    // Bring up the ledger and SDK this network speaks before any command
    // reaches them. Without it every core call fails with "No ledger loaded".
    await initSdk(resolveLedgerVersion(config));

    return config;
  }

  /**
   * Helper to extract network overrides from parsed flags.
   */
  protected getNetworkOverrides(flags: Record<string, unknown>) {
    return {
      proofServer: flags['proof-server'] as string | undefined,
      prover: flags['prover'] as string | undefined,
      indexer: flags['indexer'] as string | undefined,
      nodeUrl: flags['node-url'] as string | undefined,
    };
  }

  /**
   * Try to connect to a running TUI daemon for (network, wallet). Returns
   * a DaemonClient or null when no daemon is reachable — the calling
   * command should fall through to its standalone path on null. Callers
   * are responsible for closing the client when done.
   *
   * Failure modes folded to null (so commands can branch with a single
   * truthy check): socket file absent (no TUI), socket present but
   * stale (crashed TUI), protocol-version mismatch.
   */
  protected async tryConnectDaemon(
    networkId: string,
    walletName: string,
    opts: DaemonClientOpts = {},
  ): Promise<DaemonClient | null> {
    const result = await this.probeDaemon(networkId, walletName, opts);
    return result.client;
  }

  /**
   * Connect with structured diagnostics. Same call as tryConnectDaemon
   * but returns *why* it failed when it did, so commands can render
   * tailored remediation hints. Supports both transports:
   *
   *   - default (no `bind`):   Unix socket for (network, walletName)
   *   - `bind: "host:port"`:   TCP, with `token` required
   *
   * Authentication-related failures (refused, bad token) get distinct
   * `failure` codes so the caller's error message can be precise.
   */
  protected async probeDaemon(
    networkId: string,
    walletName: string,
    opts: DaemonClientOpts = {},
  ): Promise<DaemonConnectResult> {
    const onLog = (level: 'info' | 'warn' | 'error', msg: string) =>
      this.log_verbose(`[daemon] ${level}: ${msg}`);

    if (opts.bind) {
      const parsed = parseBindString(opts.bind);
      if (!parsed) {
        return {
          client: null,
          failure: 'tcp-refused',
          target: opts.bind,
          socketPath: '',
        };
      }
      const target = `tcp://${parsed.host}:${parsed.port}`;
      // The API token comes ONLY from the environment, never a CLI flag —
      // a flag value is readable from the process list. Same handling as
      // the wallet passphrase (MOTH_PASSPHRASE).
      const token = process.env.MOTH_DAEMON_TOKEN;
      if (!token) {
        return {client: null, failure: 'auth-failed', target, socketPath: ''};
      }
      const client = await connectDaemonTcp(parsed.host, parsed.port, {
        token,
        onLog,
      });
      if (!client) {
        // `connectDaemonTcp` folds both connect-refused and
        // auth-failure into null. The library separation isn't worth
        // surfacing here; verbose-mode logs will show which it was.
        // We tag the failure as 'tcp-refused' by default; callers
        // that pass a known-valid token can read this as "the host
        // isn't there OR the token is wrong" — the verbose log
        // disambiguates.
        return {client: null, failure: 'tcp-refused', target, socketPath: ''};
      }
      return {client, failure: null, target, socketPath: ''};
    }

    // Unix fallback (default path — preserves stage-1 behaviour).
    const socketPath = daemonSocketPath(networkId, walletName);
    const target = `unix://${socketPath}`;

    try {
      await access(socketPath);
    } catch {
      return {client: null, failure: 'no-tui', target, socketPath};
    }

    const client = await connectDaemon(socketPath, {onLog});
    if (!client) {
      // File existed at access-time but the connect either refused or
      // the handshake failed. We can't reliably distinguish stale-socket
      // from handshake-failed without surgery in connectDaemon's error
      // path — for now report the more common cause (stale) and let
      // verbose mode show the underlying reason.
      return {client: null, failure: 'stale-socket', target, socketPath};
    }
    return {client, failure: null, target, socketPath};
  }

  /**
   * Connect to the daemon or print a layered, operator-friendly error and
   * exit. Centralizes the "no daemon" messaging so every daemon-aware
   * command produces consistent output. Returns null on failure (after
   * having already called this.outputError and this.exit on the caller's
   * behalf) — caller can early-return.
   */
  protected async connectDaemonOrExit(
    networkId: string,
    walletName: string,
    opts: DaemonClientOpts = {},
  ): Promise<DaemonClient | null> {
    const {client, failure, target, socketPath} = await this.probeDaemon(networkId, walletName, opts);
    if (client) return client;

    switch (failure) {
      case 'no-tui':
        this.outputError(
          'WALLET_ERROR',
          `No TUI is hosting wallet "${walletName}" on ${networkId}. Either start the TUI (moth tui --network ${networkId}) or select this wallet in a running TUI. (Checked: ${socketPath})`,
        );
        break;
      case 'stale-socket':
        this.outputError(
          'WALLET_ERROR',
          `A socket exists at ${socketPath} but the handshake didn't complete. Possible causes: the TUI is starting up (try again in a few seconds), it's shutting down, the wallet for this socket hasn't been unlocked yet, or the file is left over from a crashed TUI. If retries fail, remove the file and restart the TUI.`,
        );
        break;
      case 'handshake-failed':
        this.outputError(
          'WALLET_ERROR',
          `Daemon at ${target} rejected the handshake. Likely a version mismatch between the CLI and the daemon — make sure both come from the same build.`,
        );
        break;
      case 'tcp-refused':
        this.outputError(
          'WALLET_ERROR',
          `Could not reach a daemon at ${target}. Likely causes: (1) no daemon listening on that host:port — start one with \`moth daemon serve --transport tcp --bind <host:port>\`; (2) wrong token — verify --token (or MOTH_DAEMON_TOKEN) matches the key the daemon is configured with; (3) malformed --bind value.`,
        );
        break;
      case 'auth-failed':
        this.outputError(
          'INVALID_INPUT',
          `--bind requires --token (or MOTH_DAEMON_TOKEN). Generate a key with \`moth daemon key gen --label "<purpose>"\` and pass the printed token.`,
        );
        break;
      default:
        this.outputError('WALLET_ERROR', `Daemon connect failed for unknown reason at ${target}`);
    }
    this.exit(1);
    return null;
  }

  /**
   * Map a DaemonProtocolError onto the WalletErrorCategory taxonomy the
   * CLI's outputError understands. Lets daemon-aware commands render
   * RPC failures with the right category and a useful prefix rather
   * than dumping every code as a generic WALLET_ERROR.
   */
  protected renderDaemonError(err: unknown): {category: WalletErrorCategory; message: string} {
    const code = (err as {code?: string}).code;
    const msg = err instanceof Error ? err.message : String(err);
    switch (code) {
      case 'UNAUTHORIZED':
        return {category: 'WALLET_ERROR', message: `Denied in TUI: ${msg}`};
      case 'INVALID_PARAMS':
      case 'INVALID_REQUEST':
      case 'METHOD_NOT_FOUND':
        return {category: 'INVALID_INPUT', message: msg};
      case 'TIMEOUT':
        return {category: 'TIMEOUT', message: msg};
      case 'CLOSED':
        return {category: 'NETWORK_ERROR', message: `Daemon connection closed: ${msg}`};
      case 'INTERNAL_ERROR':
      default:
        return {category: 'WALLET_ERROR', message: msg};
    }
  }

  protected async resolveWalletName(flags: { wallet?: string }): Promise<string> {
    if (flags.wallet) {
      this.log_verbose(`Using wallet: ${flags.wallet} (from --wallet flag)`);
      process.stderr.write(`Using wallet: ${flags.wallet}\n`);
      return flags.wallet;
    }
    const active = await this.walletManager.getActive();
    if (!active) {
      throw new WalletError('WALLET_ERROR', 'No active wallet. Run: moth wallet generate');
    }
    process.stderr.write(`Using wallet: ${active}\n`);
    return active;
  }

  /**
   * SR-003: Prompt for explicit confirmation before transaction submission.
   * Shows transaction details and requires user to type 'yes'.
   * In non-interactive mode, requires --yes flag.
   */
  protected async confirmTransaction(
    details: Record<string, string>,
    flags: { yes?: boolean },
  ): Promise<void> {
    if (flags.yes) return;

    if (!process.stdin.isTTY) {
      throw new WalletError('INVALID_INPUT', 'Non-interactive transaction requires --yes flag');
    }

    process.stderr.write('\nTransaction details:\n');
    for (const [key, value] of Object.entries(details)) {
      process.stderr.write(`  ${key.padEnd(14)} ${value}\n`);
    }
    process.stderr.write('\n');

    const answer = await this.promptIfMissing(undefined, 'Confirm transaction? (yes/no)');
    if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
      throw new WalletError('WALLET_ERROR', 'Transaction cancelled by user');
    }
  }

  protected log_verbose(message: string): void {
    if (this.verbose) {
      const ts = new Date().toISOString();
      const sanitized = sanitizeForLogging(message);
      process.stderr.write(`[${ts}] ${sanitized}\n`);
    }
  }

  protected async promptWithDefault(prompt: string, defaultValue: string): Promise<string> {
    if (!process.stdin.isTTY) {
      return defaultValue;
    }
    const { createInterface } = await import('node:readline');
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(`${prompt} [${defaultValue}]: `, (answer) => {
        rl.close();
        resolve(answer?.trim() || defaultValue);
      });
    });
  }

  protected async promptIfMissing(value: string | undefined, prompt: string): Promise<string> {
    if (value) return value;
    if (!process.stdin.isTTY) {
      throw new WalletError('INVALID_INPUT', `Missing required input: ${prompt}`);
    }
    const { createInterface } = await import('node:readline');
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(`${prompt}: `, (answer) => {
        rl.close();
        if (!answer?.trim()) {
          reject(new WalletError('INVALID_INPUT', `${prompt} cannot be empty`));
        } else {
          resolve(answer.trim());
        }
      });
    });
  }

  /**
   * Check installed @midnight-ntwrk/* package versions against the support matrix.
   * Only runs if `moth config set check-matrix true` has been set.
   * Emits warnings to stderr for mismatches — never blocks execution.
   */
  protected async checkSupportMatrix(): Promise<void> {
    const decoder = new TextDecoder();
    const enabled = await this.storage.read('config/check-matrix').then(
      d => d ? decoder.decode(d) : null,
    ).catch(() => null);

    if (enabled !== 'true') return;

    try {
      const matrixModule = '../lib/support-matrix.js';
      const { getMatrix, checkVersions } = await import(/* webpackIgnore: true */ matrixModule) as {
        getMatrix: (opts?: { overrideUrl?: string; skipFetch?: boolean; verbose?: boolean }) => Promise<any>;
        checkVersions: (matrix: any, installed: Record<string, string>) => Array<{ package: string; expected: string; actual: string; source: string }>;
      };
      const matrixUrl = await this.storage.read('config/matrix-url').then(
        d => d ? decoder.decode(d) : undefined,
      ).catch(() => undefined);

      const matrix = await getMatrix({
        overrideUrl: matrixUrl,
        verbose: this.verbose,
      });

      // Read installed versions from the nearest package.json/node_modules
      const installedVersions = await this.getInstalledMidnightVersions();
      if (Object.keys(installedVersions).length === 0) return;

      const mismatches = checkVersions(matrix, installedVersions);
      if (mismatches.length > 0) {
        process.stderr.write('\n  Support matrix version warnings:\n');
        for (const m of mismatches) {
          process.stderr.write(`    ${m.package}: installed ${m.actual}, matrix recommends ${m.expected}\n`);
        }
        process.stderr.write('  Run `moth config set check-matrix false` to disable this check.\n\n');
      }
    } catch {
      // Matrix check is best-effort — never block the CLI
    }
  }

  /**
   * Scan node_modules for installed @midnight-ntwrk/* package versions.
   */
  private async getInstalledMidnightVersions(): Promise<Record<string, string>> {
    const versions: Record<string, string> = {};
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { readdirSync, existsSync } = await import('node:fs');

      const nmDir = join(process.cwd(), 'node_modules', '@midnight-ntwrk');
      if (!existsSync(nmDir)) return versions;

      const pkgs = readdirSync(nmDir);
      for (const pkg of pkgs) {
        try {
          const pkgJson = JSON.parse(
            await readFile(join(nmDir, pkg, 'package.json'), 'utf-8'),
          );
          if (pkgJson.version) {
            versions[`@midnight-ntwrk/${pkg}`] = pkgJson.version;
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* no node_modules */ }
    return versions;
  }

  protected outputSuccess(data: unknown): void {
    this.log(formatOutput(data, this.outputFormat));
  }

  protected outputError(category: WalletErrorCategory, message: string, hint?: string): void {
    process.stderr.write(formatError(category, message, this.outputFormat, hint) + '\n');
  }

  protected async catch(err: Error & { exitCode?: number }): Promise<unknown> {
    // oclif's `this.exit(code)` throws an ExitError to terminate the
    // command — it isn't a user-facing error. Re-render it the way
    // oclif would have and propagate the original exit code; do NOT
    // call outputError, otherwise every command that uses
    // outputError() + exit(1) prints the original error AND a stray
    // "Error [WALLET_ERROR]: EEXIT: 1" trailer.
    if (err instanceof OclifErrors.ExitError) {
      throw err;
    }
    if (err instanceof WalletError) {
      this.outputError((err as WalletError).category, err.message);
      if (this.verbose) {
        const origStack = (err as any).originalStack;
        if (origStack) this.log_verbose(`Original stack:\n${origStack}`);
        if (err.stack) this.log_verbose(`Stack:\n${err.stack}`);
      }
      this.exit(1);
    }
    this.outputError('WALLET_ERROR', err.message);
    if (this.verbose && err.stack) {
      this.log_verbose(`Stack:\n${err.stack}`);
    }
    this.exit(err.exitCode ?? 1);
    return undefined;
  }
}

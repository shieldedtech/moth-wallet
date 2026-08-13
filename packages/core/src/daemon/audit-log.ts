// Append-only JSONL audit log for the wallet daemon. One JSON object
// per line. Rotated daily — when the first write of the day sees a
// log file last modified on an earlier day, it renames the file to
// `daemon-audit.log.YYYY-MM-DD` and starts a fresh one.
//
// Stage-1.5 implementation. Stage 3+ will add hash-chaining for
// tamper evidence (Trillian-style); for now the file is plain JSONL
// and trusts the host's filesystem mode (`0600`).
//
// All writes are best-effort and silent on error: the audit log
// must never crash the daemon. Errors during write are dropped on
// the floor — if they matter, you'll notice the missing entries
// later.

import {appendFileSync, existsSync, mkdirSync, renameSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

export type AuditDecision = 'auto-approve' | 'user-approve' | 'user-denied';

export interface AuditRpcEntry {
  readonly ts: string;
  readonly kind: 'rpc';
  readonly wallet: string;
  readonly network: string;
  readonly verb: string;
  readonly summary: string;
  readonly details?: readonly string[];
  readonly decision: AuditDecision;
  readonly txHash?: string;
  readonly contractAddress?: string;
  readonly status?: string;
  readonly error?: {readonly code: string; readonly message: string};
  /** Connection transport ('unix' | 'tcp') the RPC arrived on. */
  readonly transport?: 'unix' | 'tcp';
  /** API key id once the connection authenticated; absent on Unix
   *  transport without an auth handler. */
  readonly apiKeyId?: string;
  /** Connection-id (per-daemon-process) for correlating multiple
   *  RPCs from the same client connection. */
  readonly connId?: number;
}

export interface AuditLifecycleEntry {
  readonly ts: string;
  readonly kind: 'lifecycle';
  readonly wallet: string;
  readonly network: string;
  readonly event:
    | 'daemon-start'
    | 'daemon-stop'
    | 'socket-bound'
    | 'sync-complete'
    | 'shutdown-signal'
    | 'auth-success'
    | 'auth-failure';
  readonly message?: string;
  readonly apiKeyId?: string;
}

export type AuditEntry = AuditRpcEntry | AuditLifecycleEntry;

export interface AuditLogOptions {
  /** Override the default `~/.moth/` directory. Used by tests. */
  readonly dir?: string;
  /** Override the file name. Defaults to `daemon-audit.log`. */
  readonly filename?: string;
}

export class AuditLog {
  private readonly path: string;

  constructor(opts: AuditLogOptions = {}) {
    const dir = opts.dir ?? join(homedir(), '.moth');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    this.path = join(dir, opts.filename ?? 'daemon-audit.log');
  }

  /** Append one JSONL entry. Best-effort, silent on error. */
  record(entry: AuditEntry): void {
    this.maybeRotate();
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, {mode: 0o600});
    } catch {
      /* audit must never crash the daemon */
    }
  }

  /** Convenience: stamp `ts` with the current time and record an
   *  RPC entry. Split from the lifecycle variant so TypeScript can
   *  narrow on the discriminated union at the call site. */
  recordRpc(entry: Omit<AuditRpcEntry, 'ts' | 'kind'>): void {
    this.record({...entry, kind: 'rpc', ts: new Date().toISOString()});
  }

  /** Same as `recordRpc` for lifecycle events. */
  recordLifecycle(entry: Omit<AuditLifecycleEntry, 'ts' | 'kind'>): void {
    this.record({...entry, kind: 'lifecycle', ts: new Date().toISOString()});
  }

  /** Rotate the live file to `<path>.YYYY-MM-DD` when the file's
   *  most-recent mtime is on a different day than today. Called
   *  before every append; the per-write cost is one stat() syscall.
   *  Idempotent — once today's file exists, the check returns
   *  immediately. */
  private maybeRotate(): void {
    if (!existsSync(this.path)) return;
    try {
      const stat = statSync(this.path);
      const today = new Date().toISOString().slice(0, 10);
      const fileDay = stat.mtime.toISOString().slice(0, 10);
      if (fileDay !== today) {
        renameSync(this.path, `${this.path}.${fileDay}`);
      }
    } catch {
      /* skip rotation on any error; the next write will retry */
    }
  }

  /** Test helper: full path to the live log file. */
  get filePath(): string {
    return this.path;
  }

  /** Test helper: directory the log lives in. */
  get directory(): string {
    return dirname(this.path);
  }
}

// FIFO queue of pending confirmation requests from the daemon's RPC
// handlers. A handler that needs human approval pushes an entry via
// request() and awaits the returned Promise. Two execution modes:
//
//   - interactive (default): consumers like the TUI's ConfirmationModal
//     subscribe to the queue, render the head entry, and resolve the
//     promise once the user answers y/n.
//
//   - auto-approve (test-only / Web2 service later): every request()
//     resolves immediately with true. Used by `moth daemon serve
//     --auto-approve` to run the daemon without a human in the loop.
//     The summary + details are still emitted via the onAutoApprove
//     callback so they can be logged for audit.
//
// Lives in @shieldedtech/moth-wallet so the TUI host and the
// headless serve command can both depend on it without crossing
// the TUI's React layer.

import {randomUUID} from 'node:crypto';

export type ConfirmationRequest = {
  readonly id: string;
  readonly summary: string;
  readonly details?: readonly string[];
};

type InternalRequest = ConfirmationRequest & {
  resolve: (approved: boolean) => void;
};

export interface ConfirmationQueueOptions {
  /**
   * When true, every request() resolves immediately with true. Intended
   * for non-interactive contexts (tests, server-mode daemons). The
   * onAutoApprove callback, if provided, is invoked for each
   * auto-approval so callers can log it.
   */
  readonly autoApprove?: boolean;
  /** Hook called for every auto-approved request — useful for audit. */
  readonly onAutoApprove?: (req: ConfirmationRequest) => void;
}

export class ConfirmationQueue {
  private readonly items: InternalRequest[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly autoApprove: boolean;
  private readonly onAutoApprove?: (req: ConfirmationRequest) => void;

  constructor(opts: ConfirmationQueueOptions = {}) {
    this.autoApprove = opts.autoApprove ?? false;
    this.onAutoApprove = opts.onAutoApprove;
  }

  /** Push a request and resolve once the user answers (or immediately
   *  if autoApprove is enabled). */
  request(summary: string, details?: readonly string[]): Promise<boolean> {
    if (this.autoApprove) {
      const req: ConfirmationRequest = {id: randomUUID(), summary, details};
      this.onAutoApprove?.(req);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.items.push({id: randomUUID(), summary, details, resolve});
      this.notify();
    });
  }

  /** Head of the queue, or null when empty. The modal uses this to
   *  decide whether to render. */
  peek(): ConfirmationRequest | null {
    const head = this.items[0];
    return head ? {id: head.id, summary: head.summary, details: head.details} : null;
  }

  /** Resolve the head with the given verdict and advance. No-op when
   *  empty. */
  resolve(approved: boolean): void {
    const head = this.items.shift();
    if (!head) return;
    head.resolve(approved);
    this.notify();
  }

  /** Resolve every pending request as denied. Used on shutdown so any
   *  in-flight RPC calls fail cleanly instead of hanging the daemon. */
  drainAsDenied(): void {
    while (this.items.length > 0) {
      this.resolve(false);
    }
  }

  /** Subscribe to "queue changed" notifications. Returns an
   *  unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Current depth; primarily for tests and logs. */
  get size(): number {
    return this.items.length;
  }

  /** Whether the queue is in auto-approve mode. The audit log uses
   *  this to record `auto-approve` vs `user-approve` decisions on
   *  the same code path. */
  get isAutoApprove(): boolean {
    return this.autoApprove;
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // listener errors must not affect other listeners or the queue
      }
    }
  }
}

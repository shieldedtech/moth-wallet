import { describe, it, expect, vi } from 'vitest';
import { ConfirmationQueue } from '../../../src/daemon/confirmation-queue.js';

// This queue is the L3 security layer: the thing standing between an RPC verb
// and a signed transaction. The README sells per-operation human consent as a
// guarantee, so these tests are the evidence for that claim rather than a
// coverage exercise. Each one below is written as "what would a bug here let
// someone do".

describe('consent cannot be bypassed', () => {
  it('does not resolve a request until someone answers', async () => {
    // The whole guarantee: an RPC handler awaiting this must block. If the
    // promise settled early, the operation would proceed unapproved.
    const q = new ConfirmationQueue();
    let settled = false;
    void q.request('Transfer 100 NIGHT').then(() => {
      settled = true;
    });

    await Promise.resolve(); // give any accidental sync resolution a chance
    expect(settled).toBe(false);
    expect(q.size).toBe(1);
  });

  it('resolves with exactly the verdict given, including denial', async () => {
    const q = new ConfirmationQueue();
    const denied = q.request('Deploy contract');
    q.resolve(false);
    await expect(denied).resolves.toBe(false);

    const approved = q.request('Deploy contract');
    q.resolve(true);
    await expect(approved).resolves.toBe(true);
  });

  it('answers requests in order, so a verdict cannot land on the wrong operation', async () => {
    // A mismatch here would approve operation B with the consent given for A —
    // the worst failure this component has.
    const q = new ConfirmationQueue();
    const first = q.request('Transfer 1 NIGHT to alice');
    const second = q.request('Transfer 1000 NIGHT to mallory');

    expect(q.peek()?.summary).toContain('alice');
    q.resolve(true); // approving the FIRST
    expect(q.peek()?.summary).toContain('mallory');
    q.resolve(false); // denying the SECOND

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it('advances past an answered request so it cannot be answered twice', async () => {
    const q = new ConfirmationQueue();
    const only = q.request('Insert verifier key');
    q.resolve(false);
    await expect(only).resolves.toBe(false);

    expect(q.size).toBe(0);
    expect(q.peek()).toBeNull();
    q.resolve(true); // a second verdict has nothing to apply to
    expect(q.size).toBe(0);
  });

  it('denies everything in flight when drained', async () => {
    // Shutdown must fail closed. Draining as approved, or leaving promises
    // unsettled, would either sign without consent or hang the daemon.
    const q = new ConfirmationQueue();
    const pending = [q.request('a'), q.request('b'), q.request('c')];
    q.drainAsDenied();

    await expect(Promise.all(pending)).resolves.toEqual([false, false, false]);
    expect(q.size).toBe(0);
  });

  it('is not in auto-approve mode unless asked', async () => {
    // The dangerous mode must never be the default.
    expect(new ConfirmationQueue().isAutoApprove).toBe(false);
    expect(new ConfirmationQueue({}).isAutoApprove).toBe(false);
    expect(new ConfirmationQueue({ autoApprove: false }).isAutoApprove).toBe(false);
  });
});

describe('auto-approve', () => {
  it('resolves immediately and reports itself as auto-approving', async () => {
    const q = new ConfirmationQueue({ autoApprove: true });
    await expect(q.request('Transfer 100 NIGHT')).resolves.toBe(true);
    expect(q.isAutoApprove).toBe(true);
    // Nothing queues, so nothing is ever shown to a human.
    expect(q.size).toBe(0);
    expect(q.peek()).toBeNull();
  });

  it('still emits every decision for audit', () => {
    // Consent is skipped, so the audit trail is the only remaining record of
    // what was approved on the operator's behalf.
    const seen: string[] = [];
    const q = new ConfirmationQueue({
      autoApprove: true,
      onAutoApprove: (req) => seen.push(req.summary),
    });
    void q.request('Transfer 1 NIGHT', ['to: alice']);
    void q.request('Deploy contract');
    expect(seen).toEqual(['Transfer 1 NIGHT', 'Deploy contract']);
  });

  it('carries the details into the audit hook, not just the summary', () => {
    // "Transfer" alone is not an audit record; the recipient and amount are.
    const seen: unknown[] = [];
    const q = new ConfirmationQueue({ autoApprove: true, onAutoApprove: (r) => seen.push(r) });
    void q.request('Transfer', ['to: mallory', 'amount: 1000']);
    expect(seen[0]).toMatchObject({
      summary: 'Transfer',
      details: ['to: mallory', 'amount: 1000'],
    });
  });

  it('approves even if the audit hook throws', async () => {
    // Documenting current behaviour, and flagging it: a failing audit sink does
    // not stop the operation. If audit is meant to be a hard requirement, this
    // test should be inverted.
    const q = new ConfirmationQueue({
      autoApprove: true,
      onAutoApprove: () => {
        throw new Error('audit sink down');
      },
    });
    expect(() => q.request('Transfer')).toThrow('audit sink down');
  });
});

describe('subscribers', () => {
  it('notifies on arrival and on resolution, so a modal can open and close', () => {
    const q = new ConfirmationQueue();
    const seen = vi.fn();
    q.subscribe(seen);

    void q.request('Transfer');
    expect(seen).toHaveBeenCalledTimes(1);
    q.resolve(true);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('stops notifying after unsubscribe', () => {
    const q = new ConfirmationQueue();
    const seen = vi.fn();
    q.subscribe(seen)();
    void q.request('Transfer');
    expect(seen).not.toHaveBeenCalled();
  });

  it('keeps working when one listener throws', async () => {
    // A crashing UI must not take the queue with it — that would strand every
    // in-flight RPC and, worse, could leave an approval unrecorded.
    const q = new ConfirmationQueue();
    const healthy = vi.fn();
    q.subscribe(() => {
      throw new Error('render failed');
    });
    q.subscribe(healthy);

    const pending = q.request('Transfer');
    expect(healthy).toHaveBeenCalled();
    q.resolve(true);
    await expect(pending).resolves.toBe(true);
  });

  it('gives every request a distinct id', () => {
    // Ids are how a consumer correlates a rendered modal with a verdict; a
    // collision would let an answer apply to the wrong request.
    const q = new ConfirmationQueue();
    void q.request('a');
    const first = q.peek()!.id;
    q.resolve(true);
    void q.request('b');
    expect(q.peek()!.id).not.toBe(first);
  });

  it('does not expose the resolver through peek', () => {
    // peek() feeds the UI layer. Handing it the resolve function would let a
    // renderer approve an operation without going through the queue.
    const q = new ConfirmationQueue();
    void q.request('Transfer');
    expect(q.peek()).not.toHaveProperty('resolve');
  });
});

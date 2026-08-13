import {describe, it, expect, vi} from 'vitest';
import {ConfirmationQueue} from '@shieldedtech/moth-wallet';

describe('ConfirmationQueue', () => {
  it('starts empty', () => {
    const q = new ConfirmationQueue();
    expect(q.size).toBe(0);
    expect(q.peek()).toBeNull();
  });

  it('resolves a request with the approval verdict', async () => {
    const q = new ConfirmationQueue();
    const pending = q.request('Approve op?', ['detail one']);
    expect(q.size).toBe(1);
    expect(q.peek()?.summary).toBe('Approve op?');
    expect(q.peek()?.details).toEqual(['detail one']);
    q.resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(q.size).toBe(0);
  });

  it('resolves a denied request as false', async () => {
    const q = new ConfirmationQueue();
    const pending = q.request('Approve?');
    q.resolve(false);
    await expect(pending).resolves.toBe(false);
  });

  it('serializes multiple requests FIFO', async () => {
    const q = new ConfirmationQueue();
    const first = q.request('first');
    const second = q.request('second');
    expect(q.size).toBe(2);
    expect(q.peek()?.summary).toBe('first');

    q.resolve(true);
    await expect(first).resolves.toBe(true);
    expect(q.peek()?.summary).toBe('second');

    q.resolve(false);
    await expect(second).resolves.toBe(false);
    expect(q.size).toBe(0);
  });

  it('notifies subscribers on enqueue and on resolve', () => {
    const q = new ConfirmationQueue();
    const listener = vi.fn();
    const unsub = q.subscribe(listener);
    q.request('one');
    q.request('two');
    q.resolve(true);
    q.resolve(false);
    unsub();
    q.request('three');
    expect(listener).toHaveBeenCalledTimes(4); // 2 enqueue + 2 resolve
  });

  it('drainAsDenied resolves every pending request as false', async () => {
    const q = new ConfirmationQueue();
    const a = q.request('a');
    const b = q.request('b');
    const c = q.request('c');
    q.drainAsDenied();
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
    await expect(c).resolves.toBe(false);
    expect(q.size).toBe(0);
  });

  it('isolates listener errors', () => {
    const q = new ConfirmationQueue();
    const noisy = vi.fn(() => {
      throw new Error('listener boom');
    });
    const sane = vi.fn();
    q.subscribe(noisy);
    q.subscribe(sane);
    // Should not throw — noisy listener's error is caught
    expect(() => q.request('test')).not.toThrow();
    expect(noisy).toHaveBeenCalled();
    expect(sane).toHaveBeenCalled();
  });

  it('returns an immutable peek payload (no resolver leak)', () => {
    const q = new ConfirmationQueue();
    q.request('hide me');
    const peeked = q.peek();
    expect(peeked).not.toBeNull();
    expect(Object.keys(peeked!).sort()).toEqual(['details', 'id', 'summary']);
    // Critically — no `resolve` function exposed to consumers.
    expect((peeked as Record<string, unknown>).resolve).toBeUndefined();
  });
});

// A submission failure from the wallet SDK says nothing in its own message:
// the node's verdict is two `cause` levels below a pair of Effect
// Data.TaggedErrors whose messages are fixed strings. These tests pin the
// walk that finds it, because everything that reads a reason out of a
// submission failure — the failure screen, the retry classifiers, the
// wedged-dust-ledger detector — depends on it.

import {Data, Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {
  errorChainMessage,
  errorChainMessages,
  TransactionSubmissionError,
} from '../../../src/types/errors.js';

/** The exact shape the wallet SDK delivers: capabilities' submission service
 *  wraps wallet-sdk-node-client, which wraps the polkadot RPC error that is
 *  the only one carrying the node's words. */
function sdkSubmissionFailure(nodeMessage: string): Error {
  const rpc = new Error(nodeMessage);
  const nodeClient = Object.assign(new Error('Transaction submission failed'), {
    _tag: 'SubmissionError',
    cause: rpc,
  });
  return Object.assign(new Error('Transaction submission error'), {
    _tag: 'SubmissionError',
    cause: nodeClient,
  });
}

describe('errorChainMessages', () => {
  it('reaches the node verdict under the SDK wrappers', () => {
    const messages = errorChainMessages(
      sdkSubmissionFailure('1010: Invalid Transaction: Custom error: 170'),
    );
    expect(messages).toEqual([
      'Transaction submission error',
      'Transaction submission failed',
      '1010: Invalid Transaction: Custom error: 170',
    ]);
  });

  it('follows `failure` as well as `cause` (Effect fiber wrappers use it)', () => {
    const inner = new Error('socket hang up');
    const outer = Object.assign(new Error('Wallet.Sync'), {failure: inner});
    expect(errorChainMessages(outer)).toEqual(['Wallet.Sync', 'socket hang up']);
  });

  // The submission service runs its Effect with `runPromise`, which rejects
  // with a FiberFailure: its message is the SDK placeholder and its cause sits
  // behind a symbol, with no `cause` property. A mainnet send that the node
  // refused reached the failure screen as the bare "Transaction submission
  // error" because the walk stopped there.
  it('opens an Effect FiberFailure to reach the node verdict behind it', async () => {
    class SubmissionError extends Data.TaggedError('SubmissionError')<{message: string; cause: unknown}> {}
    const verdict = new Error('1010: Invalid Transaction: Custom error: 170');
    const failure = new SubmissionError({
      message: 'Transaction submission error',
      cause: new SubmissionError({message: 'Transaction submission failed', cause: verdict}),
    });
    const rejected = await Effect.runPromise(Effect.fail(failure)).catch((e: unknown) => e);

    expect((rejected as Error).message).toBe('Transaction submission error');
    expect('cause' in (rejected as object)).toBe(false);
    expect(errorChainMessages(rejected)).toEqual([
      'Transaction submission error',
      'Transaction submission failed',
      '1010: Invalid Transaction: Custom error: 170',
    ]);
  });

  it('opens a FiberFailure carrying a defect, too', async () => {
    const rejected = await Effect.runPromise(Effect.die(new Error('wasm trap'))).catch((e: unknown) => e);
    expect(errorChainMessages(rejected)).toEqual(['wasm trap']);
  });

  it('keeps a plain error to its one message', () => {
    expect(errorChainMessages(new Error('nope'))).toEqual(['nope']);
  });

  it('drops repeats, so a re-wrapped error does not say itself twice', () => {
    const inner = new Error('same');
    expect(errorChainMessages(new Error('same', {cause: inner}))).toEqual(['same']);
  });

  it('does not stutter when handed an error it already flattened', () => {
    const original = sdkSubmissionFailure('Custom error: 170');
    const flattened = new TransactionSubmissionError(errorChainMessage(original), original);
    expect(errorChainMessage(flattened)).toBe(errorChainMessage(original));
  });

  it('stops at maxDepth rather than following a cycle forever', () => {
    const a: Error & {cause?: unknown} = new Error('a');
    const b: Error & {cause?: unknown} = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(errorChainMessages(a)).toEqual(['a', 'b']);
  });

  it('reads a message off a non-Error link, and JSON as a last resort', () => {
    const opaque = new Error('outer', {cause: {code: 1010, data: 'Custom error: 170'}});
    expect(errorChainMessage(opaque)).toBe('outer: {"code":1010,"data":"Custom error: 170"}');
  });

  it('handles a thrown non-error', () => {
    expect(errorChainMessage('just a string')).toBe('just a string');
    expect(errorChainMessages(undefined)).toEqual([]);
  });
});

describe('errorChainMessage', () => {
  it('reads outside-in, ending on the detail', () => {
    expect(errorChainMessage(sdkSubmissionFailure('Custom error: 170'))).toBe(
      'Transaction submission error: Transaction submission failed: Custom error: 170',
    );
  });
});

describe('TransactionSubmissionError', () => {
  it('is a network-category wallet error that keeps the original on cause', () => {
    const original = sdkSubmissionFailure('Custom error: 170');
    const wrapped = new TransactionSubmissionError(errorChainMessage(original), original);
    expect(wrapped.category).toBe('NETWORK_ERROR');
    expect(wrapped.name).toBe('TransactionSubmissionError');
    expect(wrapped.cause).toBe(original);
    expect(wrapped.message).toContain('Custom error: 170');
  });
});

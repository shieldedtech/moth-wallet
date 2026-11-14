// The facade's state replays its current value synchronously on subscribe. The
// hand-rolled "wait for the first emission" this replaces reached for its own
// subscription from inside the handler, which a synchronous emission turns into
// a temporal-dead-zone error the moment the wallet starts.

import {describe, expect, it} from 'vitest';
import * as Rx from 'rxjs';
import {firstEmission} from '../../../src/sync/wallet-sync.js';

describe('firstEmission', () => {
  it('takes a value that is emitted synchronously on subscribe', async () => {
    await expect(firstEmission(new Rx.BehaviorSubject('now'), 1_000)).resolves.toBe('now');
  });

  it('takes the first of several later values and stops listening', async () => {
    const subject = new Rx.Subject<number>();
    const pending = firstEmission(subject, 1_000);
    subject.next(1);
    subject.next(2);
    await expect(pending).resolves.toBe(1);
    expect(subject.observed).toBe(false);
  });

  it('gives up with undefined when nothing is emitted in time', async () => {
    await expect(firstEmission(Rx.NEVER, 20)).resolves.toBeUndefined();
  });
});

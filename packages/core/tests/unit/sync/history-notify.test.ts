// A submission's pending and rejected history entries move no sync counter, so
// the host learns of them only through this hook. These run the SDK's own
// storage, so a change to how it records them is caught here.

import {describe, expect, it, vi} from 'vitest';
import {InMemoryTransactionHistoryStorage} from '@midnightntwrk/wallet-sdk';
import {WalletEntrySchema, mergeWalletEntries} from '@midnightntwrk/wallet-sdk/facade';
import {notifyOnSubmissionVerdicts} from '../../../src/sync/history-notify.js';

const HASH = 'a'.repeat(64);

function storage(onChange: (hash: string) => void) {
  return notifyOnSubmissionVerdicts(
    new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    onChange
  );
}

describe('notifyOnSubmissionVerdicts', () => {
  it('reports a pending entry once it is readable', async () => {
    const seen: Array<string | undefined> = [];
    const history = storage(() => {
      void history.get(HASH).then((entry) => seen.push(entry?.lifecycle.status));
    });

    await history.gotPending({hash: HASH, identifiers: ['id-1'], submittedAt: new Date()});
    await Promise.resolve();

    expect(seen).toEqual(['pending']);
  });

  it('reports the rejection that replaces it', async () => {
    const onChange = vi.fn();
    const history = storage(onChange);

    await history.gotPending({hash: HASH, identifiers: ['id-1'], submittedAt: new Date()});
    await history.gotRejected({hash: HASH, identifiers: ['id-1'], rejectedAt: new Date()});

    expect(onChange.mock.calls).toEqual([[HASH], [HASH]]);
    expect((await history.get(HASH))?.lifecycle.status).toBe('rejected');
  });

  it('still serializes what it recorded', async () => {
    const history = storage(() => {});
    await history.gotPending({hash: HASH, identifiers: ['id-1'], submittedAt: new Date()});

    expect(await history.serialize()).toContain(HASH);
  });

  it('keeps the write when the listener throws', async () => {
    const history = storage(() => {
      throw new Error('listener failed');
    });

    await expect(
      history.gotPending({hash: HASH, identifiers: ['id-1'], submittedAt: new Date()})
    ).resolves.toBeUndefined();
    expect(await history.get(HASH)).toBeDefined();
  });
});

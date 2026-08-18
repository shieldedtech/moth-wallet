/**
 * The two ledgers do not read each other's transactions. Verified against live
 * networks on 2026-08-18: a preprod transaction (protocolVersion 1000000) is
 * tagged `transaction[v9](signature[v1],...)` and only v8 accepts it; a devnet
 * transaction (protocolVersion 2000000) is tagged
 * `transaction[v12](signature[v2],...)` and only v9 accepts it.
 *
 * That makes protocolVersion the network's ledger generation, and it means
 * pointing a v8 build at a 2000000 network fails at the first transaction
 * rather than degrading. Upstream's coexistence spike (midnight-wallet#629)
 * deliberately left this unasserted, so it is pinned here.
 *
 * The tags are asserted through each module's own error message, so the test
 * stays hermetic — no network, no multi-kilobyte transaction fixtures.
 */

import {describe, expect, it} from 'vitest';
import {initLedger} from '../../../src/ledger/index.js';

/** A buffer carrying a header tag neither ledger will accept. */
const bogus = new TextEncoder().encode('midnight:transaction[v0](signature[v0],proof,pedersen-schnorr[v1]):');

async function expectedTag(version: 'v8' | 'v9'): Promise<string> {
  const mod = await initLedger(version);
  try {
    (mod.Transaction.deserialize as (...a: unknown[]) => unknown)('signature', 'proof', 'binding', bogus);
  } catch (err) {
    return String((err as Error).message ?? err);
  }
  throw new Error(`${version} accepted a bogus header tag`);
}

describe('ledger fork incompatibility', () => {
  it('v8 expects the pre-fork transaction format', async () => {
    const message = await expectedTag('v8');
    expect(message).toContain('transaction[v9]');
    expect(message).toContain('signature[v1]');
  });

  it('v9 expects the post-fork transaction format', async () => {
    const message = await expectedTag('v9');
    expect(message).toContain('transaction[v12]');
    expect(message).toContain('signature[v2]');
  });

  it('the two disagree — which is why a network needs the right ledger', async () => {
    expect(await expectedTag('v8')).not.toBe(await expectedTag('v9'));
  });
});

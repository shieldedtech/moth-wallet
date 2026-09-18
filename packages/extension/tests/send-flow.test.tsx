import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Edit, FeeEstimateCard, Review, Pending, type OutputSummary } from '../components/screens/SendFlow';
import { buildBatch, type OutputDraft } from '../lib/ui/send-batch';
import type { SendableToken } from '../lib/ui/token-list';

const NIGHT: SendableToken = {
  id: '0'.repeat(64),
  kind: 'unshielded',
  symbol: 'tNIGHT',
  name: 'Midnight',
  balance: 2_000_000n,
  decimals: 6,
};
// A real bech32m unshielded address (valid checksum) — buildBatch now verifies
// the checksum, so a placeholder like `mn_addr…aaaa` no longer validates.
const address = 'mn_addr_preprod1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qursfw7h6g';

function draft(over: Partial<OutputDraft> = {}): OutputDraft {
  return { id: 'x', tokenId: NIGHT.id, amount: '1', to: address, ...over };
}

describe('transfer fee estimate UI', () => {
  it('labels the facade result as an estimate and warns that it may vary', () => {
    const html = renderToStaticMarkup(
      <FeeEstimateCard estimate={{ status: 'ready', fee: '125000000000000' }} dustLabel="tDUST" />,
    );

    expect(html).toContain('Network fee');
    expect(html).not.toContain('Estimated network fee');
    expect(html).toContain('≈ 0.125 tDUST');
    expect(html).toContain('Estimate');
    expect(html).toContain('final fee may vary');
  });

  it('uses an honest loading state while calculating', () => {
    const html = renderToStaticMarkup(<FeeEstimateCard estimate={{ status: 'loading' }} dustLabel="DUST" />);
    expect(html).toContain('Calculating…');
    expect(html).toContain('including the DUST payment');
  });

  it('does not block the user conceptually when estimation is unavailable', () => {
    const html = renderToStaticMarkup(<FeeEstimateCard estimate={{ status: 'unavailable' }} dustLabel="DUST" />);
    expect(html).toContain('Unavailable right now');
    expect(html).toContain('You can still send');
  });

  it('shows the estimate treatment on the edit step', () => {
    const batch = buildBatch([draft()], [NIGHT]);
    const html = renderToStaticMarkup(
      <Edit
        drafts={[draft()]}
        setDrafts={() => {}}
        batch={batch}
        tokens={[NIGHT]}
        book={[]}
        resolutionForTo={() => undefined}
        dustLabel="tDUST"
        feeEstimate={{ status: 'ready', fee: '125000000000000' }}
        onBack={() => {}}
        onReview={() => {}}
      />,
    );

    expect(html).toContain('Network fee');
    expect(html).toContain('≈ 0.125 tDUST');
    expect(html).toContain('Add another transfer');
  });

  it('shows every output and the fee on review', () => {
    const outputs: OutputSummary[] = [
      { symbol: 'tNIGHT', amount: '1', to: address, kind: 'unshielded' },
      { symbol: 'URGH', amount: '50', to: `mn_shield-addr_preprod1${'b'.repeat(30)}`, kind: 'shielded' },
    ];
    const html = renderToStaticMarkup(
      <Review
        outputs={outputs}
        from="Account-1"
        dustLabel="tDUST"
        feeEstimate={{ status: 'ready', fee: '125000000000000' }}
        onBack={() => {}}
        onSend={() => {}}
      />,
    );

    expect(html).toContain('sending 2 transfers');
    expect(html).toContain('1 tNIGHT');
    expect(html).toContain('50 URGH');
    expect(html).toContain('≈ 0.125 tDUST');
    expect(html).toContain('Send now');
  });
});

describe('transfer proving status', () => {
  const outputs = [{ symbol: 'tNIGHT', amount: '1', to: address, kind: 'unshielded' as const }];

  it.each([
    ['wasm', 'Proving on this device — a few minutes is normal.'],
    ['server', 'Runs on your proof server, details never leave it'],
  ] as const)('shows the selected %s proving method', (proverType, message) => {
    const html = renderToStaticMarkup(
      <Pending outputs={outputs} dustLabel="" txStage="proving" proverType={proverType} />,
    );

    expect(html).toContain(message);
    expect(html).not.toContain('selected in Network settings');
  });

  // Local proving runs for minutes with nothing else to observe, so the note
  // moves: an elapsed clock (from the stage's start stamp) beside the moth.
  it('counts elapsed time from when local proving began', () => {
    const html = renderToStaticMarkup(
      <Pending outputs={outputs} dustLabel="" txStage="proving" txStageSince={Date.now() - 95_000} proverType="wasm" />,
    );

    expect(html).toContain('1:35 elapsed');
    expect(html).toContain('Your transaction details never leave this browser.');
  });

  it('shows no clock before proving starts, or with a proof server', () => {
    const building = renderToStaticMarkup(
      <Pending outputs={outputs} dustLabel="" txStage="building" txStageSince={Date.now()} proverType="wasm" />,
    );
    const server = renderToStaticMarkup(
      <Pending outputs={outputs} dustLabel="" txStage="proving" txStageSince={Date.now()} proverType="server" />,
    );

    expect(building).not.toContain('elapsed');
    expect(server).not.toContain('elapsed');
  });

  // "Under a minute" is the proof-server figure; promising it for WASM makes a
  // working wallet look stuck.
  it('sets a minutes-long expectation for local proving instead of "under a minute"', () => {
    const local = renderToStaticMarkup(
      <Pending outputs={outputs} dustLabel="" txStage="proving" proverType="wasm" />,
    );
    const server = renderToStaticMarkup(
      <Pending outputs={outputs} dustLabel="" txStage="proving" proverType="server" />,
    );

    expect(local).toContain('Local proving usually takes a few minutes.');
    expect(local).not.toContain('under a minute');
    expect(server).toContain('This usually takes under a minute.');
  });
});

describe('buildBatch', () => {
  it('produces a request per valid line', () => {
    const batch = buildBatch([draft()], [NIGHT]);
    expect(batch.valid).toBe(true);
    expect(batch.requests).toEqual([
      { type: 'unshielded', tokenId: NIGHT.id, amount: '1000000', to: address },
    ]);
  });

  it('rejects a recipient of the wrong kind for the token', () => {
    const batch = buildBatch([draft({ to: `mn_shield-addr_preprod1${'a'.repeat(30)}` })], [NIGHT]);
    expect(batch.lines[0].addressValid).toBe(false);
    expect(batch.valid).toBe(false);
  });

  it('flags overspend when two lines exceed a token balance together', () => {
    const drafts = [draft({ id: 'a', amount: '1.5' }), draft({ id: 'b', amount: '1' })];
    const batch = buildBatch(drafts, [NIGHT]); // 2.5 tNIGHT > 2.0 balance
    expect(batch.lines.every((l) => l.overspent)).toBe(true);
    expect(batch.valid).toBe(false);
  });

  it('allows two lines that together stay within balance', () => {
    const drafts = [draft({ id: 'a', amount: '1' }), draft({ id: 'b', amount: '0.5' })];
    const batch = buildBatch(drafts, [NIGHT]);
    expect(batch.valid).toBe(true);
    expect(batch.requests).toHaveLength(2);
  });
});

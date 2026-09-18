import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  collapseDustReference,
  DustCollapseError,
  inspectDustSnapshot,
  treeFrontier,
  type DustCollapseFailure,
} from '../../../src/sync/dust-reference-collapse.js';

// See tests/fixtures/preseed/README.md for where these came from.
const fixture = (name: string) => readFileSync(new URL(`../../fixtures/preseed/${name}`, import.meta.url));
const REFERENCE = gunzipSync(fixture('preview-519470-dust.dat.gz')).toString('utf8');
const EVENTS = JSON.parse(gunzipSync(fixture('preview-dust-events-141065-142216.json.gz')).toString('utf8')) as {
  id: number;
  raw: string;
}[];

// Read off this fixture's ledger refusals; pinned below.
const GENERATION_FIRST_FREE = 5886n;
const COMMITMENT_FIRST_FREE = 67922n;

const NOW = new Date('2026-09-15T00:00:00Z');

const stateOf = (json: string) =>
  ledger.DustLocalState.deserialize(Buffer.from((JSON.parse(json) as {state: string}).state, 'hex'));
const withState = (json: string, state: ledger.DustLocalState) =>
  json.replace(/"state":"[0-9a-fA-F]*"/, `"state":"${Buffer.from(state.serialize()).toString('hex')}"`);
const withoutState = (json: string) => json.replace(/"state":"[0-9a-fA-F]*"/, '"state":""');

const snapshot = (state: ledger.DustLocalState) => ({
  generationRoot: state.generatingTreeRoot(),
  commitmentRoot: state.commitmentTreeRoot(),
  balance: state.walletBalance(NOW),
  utxos: state.utxos.length,
});

function expectFailure(run: () => unknown, reason: DustCollapseFailure): void {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(DustCollapseError);
  expect((thrown as DustCollapseError).reason).toBe(reason);
}

const PROBE_GENERATION = {value: 0n, owner: 0n, nonce: '00'.repeat(32), dtime: undefined};
const PROBE_OUTPUT = {
  initialValue: 0n,
  owner: 0n,
  nonce: 0n,
  seq: 0,
  ctime: new Date(0),
  backingNight: '00'.repeat(32),
  mtIndex: 0n,
};

describe('collapseDustReference', () => {
  it('shrinks the preview reference without changing anything it means', () => {
    const {json, report} = collapseDustReference(REFERENCE, NOW);

    expect(report.changed).toBe(true);
    expect(report.stateBytesBefore).toBe(131_427);
    expect(report.stateBytesAfter).toBeLessThan(8_192);

    const before = inspectDustSnapshot(REFERENCE);
    const after = inspectDustSnapshot(json);
    expect(after).toEqual({...before, stateBytes: report.stateBytesAfter});
    expect(after).toMatchObject({
      utxos: 0,
      generationFirstFree: GENERATION_FIRST_FREE,
      commitmentFirstFree: COMMITMENT_FIRST_FREE,
    });
  });

  it('leaves every byte of the envelope but the state exactly as it was', () => {
    // offset is the indexer cursor the wallet resumes from and the one the bundle's
    // witness vouches for, so it in particular must survive untouched.
    const {json} = collapseDustReference(REFERENCE, NOW);
    expect(withoutState(json)).toBe(withoutState(REFERENCE));
  });

  it('hands an already-collapsed snapshot back byte-for-byte', () => {
    const once = collapseDustReference(REFERENCE, NOW);
    const twice = collapseDustReference(once.json, NOW);

    expect(twice.report.changed).toBe(false);
    expect(twice.json).toBe(once.json);
  });

  it('refuses a snapshot that owns DUST', () => {
    // Collapsing drops the generation data behind an owned UTXO, and on 8.1.x the
    // next balance read panics. The reference owns nothing; anything else is refused.
    const owning = stateOf(REFERENCE).addUtxo(1n, PROBE_OUTPUT as ledger.QualifiedDustOutput);
    expect(owning.utxos.length).toBe(1);

    expectFailure(() => collapseDustReference(withState(REFERENCE, owning), NOW), 'owns-dust');
  });

  it('refuses input it cannot read, rather than guessing at it', () => {
    for (const input of [
      'not json',
      '{"offset":"141062"}',
      '{"state":"abc"}',
      '{"state":"zz"}',
      '{"state":"00ff"}',
      '{"state":"00","nested":{"state":"00"}}',
    ]) {
      expectFailure(() => collapseDustReference(input, NOW), 'unreadable');
    }
  });
});

/** TreeInsertionPath entries run from the leaf up, so the index reads from the last entry down. */
function leafIndex(path: {goesLeft: boolean}[]): bigint {
  let index = 0n;
  for (let i = path.length - 1; i >= 0; i--) index = (index << 1n) | (path[i].goesLeft ? 0n : 1n);
  return index;
}

describe('a collapsed reference syncs forward exactly as the original', () => {
  it('replays the events that followed the reference to identical roots, balance and UTXOs', () => {
    const secretKey = ledger.DustSecretKey.fromSeed(crypto.getRandomValues(new Uint8Array(32)));
    let original = stateOf(REFERENCE);
    let collapsed = stateOf(collapseDustReference(REFERENCE, NOW).json);
    let dtimeUpdatesInsideCollapsedRange = 0;

    for (let i = 0; i < EVENTS.length; i += 100) {
      const batch = EVENTS.slice(i, i + 100);
      // replayEvents takes ownership of the Event objects it is handed, so each
      // state is given its own.
      const decode = () => batch.map((event) => ledger.Event.deserialize(Buffer.from(event.raw, 'hex')));
      for (const event of decode()) {
        const content = event.content as {tag: string; update?: {path: {goesLeft: boolean}[]}};
        if (content.tag === 'dustGenerationDtimeUpdate' && leafIndex(content.update!.path) < GENERATION_FIRST_FREE) {
          dtimeUpdatesInsideCollapsedRange += 1;
        }
      }
      original = original.replayEvents(secretKey, decode()).processTtls(NOW);
      collapsed = collapsed.replayEvents(secretKey, decode()).processTtls(NOW);

      expect(snapshot(collapsed), `after event ${batch.at(-1)!.id}`).toEqual(snapshot(original));
    }

    // The case that matters: a dtime update landing on a leaf the collapse removed.
    // A slice without these would only prove that appends still work.
    expect(dtimeUpdatesInsideCollapsedRange).toBeGreaterThanOrEqual(5);

    const reloaded = ledger.DustLocalState.deserialize(collapsed.serialize());
    expect(snapshot(reloaded)).toEqual(snapshot(original));
  });
});

// ledger-v8 8.1.x has no getter for a tree's first free index, and the collapse
// cannot be bounded without it. treeFrontier reads the number out of an insert
// refusal instead. This suite exists to say plainly that this is a hack, and to pin
// exactly what the hack depends on: the day these fail, the ledger has changed,
// and the fix is to read `generatingTreeFirstFree` / `commitmentTreeFirstFree`
// rather than to loosen the pattern.
describe('treeFrontier: a workaround for ledger-v8 8.1.x, pinned on purpose', () => {
  it('is still needed, because this ledger exposes no first-free property', () => {
    const state = stateOf(REFERENCE) as unknown as Record<string, unknown>;
    expect(state.generatingTreeFirstFree).toBeUndefined();
    expect(state.commitmentTreeFirstFree).toBeUndefined();
  });

  it('depends on the ledger refusing a non-linear insert in exactly these words', () => {
    const state = stateOf(REFERENCE);
    expect(() => state.insertGenerationInfo(0n, PROBE_GENERATION)).toThrow(
      `expected to insert index ${GENERATION_FIRST_FREE}`,
    );
    expect(() => state.insertCommitment(0n, PROBE_OUTPUT as ledger.QualifiedDustOutput, false)).toThrow(
      `expected to insert index ${COMMITMENT_FIRST_FREE}`,
    );
  });

  it('reads the frontier out of that refusal', () => {
    const state = stateOf(REFERENCE);
    expect(treeFrontier(state, 'generation')).toBe(GENERATION_FIRST_FREE);
    expect(treeFrontier(state, 'commitment')).toBe(COMMITMENT_FIRST_FREE);
  });

  it('prefers the ledger’s own property wherever one exists', () => {
    const state = {generatingTreeFirstFree: 42n, commitmentTreeFirstFree: 7n} as unknown as ledger.DustLocalState;
    expect(treeFrontier(state, 'generation')).toBe(42n);
    expect(treeFrontier(state, 'commitment')).toBe(7n);
  });

  it('fails loudly, naming the fix, if the refusal is ever reworded', () => {
    const reworded = {
      insertGenerationInfo: () => {
        throw new Error('generation tree index mismatch');
      },
    } as unknown as ledger.DustLocalState;
    expectFailure(() => treeFrontier(reworded, 'generation'), 'unverified');
    expect(() => treeFrontier(reworded, 'generation')).toThrow(/generatingTreeFirstFree/);
  });
});

import {describe, it, expect, vi} from 'vitest';
import {__TEST_ONLY__} from '../../../src/sync/sdk-dedup.js';

const {partitionByAppliedIndex, makeDedupingApplyUpdate} = __TEST_ONLY__;

type FakeUpdate = {id: number | bigint | string; maxId: number; raw?: unknown; event?: unknown};
type FakeState = {progress: {appliedIndex: bigint; isConnected?: boolean; highestRelevantWalletIndex?: bigint}; protocolVersion: number};

const makeState = (appliedIndex: bigint): FakeState => ({
  progress: {appliedIndex},
  protocolVersion: 1,
});

describe('partitionByAppliedIndex', () => {
  it('drops no events when all are fresh', () => {
    const r = partitionByAppliedIndex(
      [{id: 5, maxId: 10}, {id: 6, maxId: 10}, {id: 7, maxId: 10}],
      4n,
    );
    expect(r.droppedCount).toBe(0);
    expect(r.fresh).toHaveLength(3);
  });

  it('drops every event when all are <= appliedIndex', () => {
    const r = partitionByAppliedIndex(
      [{id: 1, maxId: 10}, {id: 2, maxId: 10}, {id: 3, maxId: 10}],
      5n,
    );
    expect(r.droppedCount).toBe(3);
    expect(r.fresh).toHaveLength(0);
  });

  it('drops only the already-applied prefix in a mixed batch', () => {
    const r = partitionByAppliedIndex(
      [{id: 3, maxId: 10}, {id: 4, maxId: 10}, {id: 5, maxId: 10}, {id: 6, maxId: 10}],
      4n,
    );
    expect(r.droppedCount).toBe(2);
    expect(r.fresh.map((u) => Number(u.id))).toEqual([5, 6]);
  });

  it('treats id == appliedIndex as already applied (the boundary case)', () => {
    // The exact failure mode the SDK trips: indexer re-sends event N
    // (= appliedIndex), wallet's tree already has it, the dedup
    // wrapper must drop it before WASM rejects.
    const r = partitionByAppliedIndex(
      [{id: 10137, maxId: 10138}, {id: 10138, maxId: 10138}],
      10137n,
    );
    expect(r.droppedCount).toBe(1);
    expect(r.fresh.map((u) => Number(u.id))).toEqual([10138]);
  });

  it('coerces string and bigint ids through BigInt comparison', () => {
    const r = partitionByAppliedIndex(
      [{id: '100', maxId: 200}, {id: 101n, maxId: 200}, {id: 102, maxId: 200}],
      100n,
    );
    expect(r.droppedCount).toBe(1);
    expect(r.fresh.map((u) => Number(u.id))).toEqual([101, 102]);
  });
});

describe('makeDedupingApplyUpdate', () => {
  const noopUpdateProgress = (s: FakeState, patch: {highestRelevantWalletIndex: bigint; isConnected: boolean}): FakeState => ({
    ...s,
    progress: {...s.progress, ...patch},
  });

  it('forwards the original batch when no dedup is needed', () => {
    const base = {applyUpdate: vi.fn().mockImplementation((state: FakeState) => [state, {changes: [], protocolVersion: 1}])};
    const wrapped = makeDedupingApplyUpdate(base, noopUpdateProgress);
    const state = makeState(4n);
    const batch = {updates: [{id: 5, maxId: 10}, {id: 6, maxId: 10}]};
    wrapped(state, batch);
    expect(base.applyUpdate).toHaveBeenCalledTimes(1);
    expect(base.applyUpdate.mock.calls[0]![1]).toBe(batch); // forwarded as-is, not reconstructed
  });

  it('short-circuits when the entire batch is already applied', () => {
    const base = {applyUpdate: vi.fn()};
    const wrapped = makeDedupingApplyUpdate(base, noopUpdateProgress);
    const state = makeState(10n);
    const batch = {updates: [{id: 5, maxId: 12}, {id: 8, maxId: 12}, {id: 10, maxId: 12}]};
    const [newState, result] = wrapped(state, batch);
    expect(base.applyUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({changes: [], protocolVersion: 1});
    // highestRelevantWalletIndex must be advanced from the batch tail's
    // maxId so downstream observers see we're still moving forward.
    expect(newState.progress.highestRelevantWalletIndex).toBe(12n);
    expect(newState.progress.isConnected).toBe(true);
  });

  it('strips the boundary duplicate from a mixed batch and forwards the suffix', () => {
    // The bug scenario: appliedIndex is 10137; indexer re-sends 10137
    // as the head of a new batch ending at 10145. Without dedup the
    // SDK's last-check sees 10145 > 10137 and passes everything to
    // WASM, which rejects on the duplicate at 10137.
    const captured: Array<{updates: FakeUpdate[]}> = [];
    const base = {applyUpdate: vi.fn().mockImplementation((state: FakeState, batch: {updates: FakeUpdate[]}) => {
      captured.push(batch);
      return [state, {changes: [], protocolVersion: 1}];
    })};
    const wrapped = makeDedupingApplyUpdate(base, noopUpdateProgress);
    const state = makeState(10137n);
    const batch = {
      updates: [
        {id: 10137, maxId: 10145, raw: 'dup'},
        {id: 10138, maxId: 10145, raw: 'fresh-a'},
        {id: 10145, maxId: 10145, raw: 'fresh-b'},
      ],
    };
    wrapped(state, batch);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.updates.map((u) => Number(u.id))).toEqual([10138, 10145]);
  });

  it('passes the empty-batch case straight to the SDK', () => {
    const base = {applyUpdate: vi.fn().mockReturnValue([{} as FakeState, {changes: [], protocolVersion: 0}])};
    const wrapped = makeDedupingApplyUpdate(base, noopUpdateProgress);
    wrapped(makeState(0n), {updates: []});
    expect(base.applyUpdate).toHaveBeenCalledTimes(1);
  });
});

// Collapse the DUST Merkle trees inside a pre-seed reference's dust snapshot.
//
// Why this exists
// ---------------
// A wallet seeded from the reference inherits its dust state, and restoring that
// state is one `DustLocalState.deserialize` on every launch. On preprod the state
// was 5,474,535 bytes and the deserialize took ~57s in Node — nearly all of a new
// wallet's start-up, every time it started. Almost all of those bytes are the
// generation tree, bloated by a ledger-v8 8.1.x defect: replay collapses each
// generation the wallet does not own, but a later dtime update that lands on an
// already-collapsed leaf re-expands it, and nothing collapses it again. Both
// shapes hash to the same root, so the bloat costs space and time and nothing
// else, which is why it survived. ledger-v9 fixes the re-expansion.
//
// Collapsing the populated range of both trees, once, wherever a reference is
// produced, takes that state to ~3.7 KB and the deserialize to milliseconds. The
// roots and the frontier do not move, so a wallet restored from the collapsed
// state syncs forward exactly as one restored from the original: replaying the
// 71,507 preprod events that followed the reference — 940 of them dtime updates
// landing inside the collapsed range — gave identical roots, balance and UTXOs
// after every batch. The unit tests replay a recorded preview slice to keep
// proving it.
//
// Only for a wallet that owns no DUST. Collapsing drops leaf data, and on 8.1.x
// reading a collapsed leaf the wallet owns panics rather than failing cleanly.
// The reference owns nothing by construction; this still refuses any snapshot
// holding UTXOs instead of trusting its caller.
//
// Every entry point verifies what it returns and throws rather than hand back
// anything it could not check, so a caller holding a result holds a verified one.

import * as ledger from '@midnight-ntwrk/ledger-v8';

/** Why a snapshot was not collapsed. */
export type DustCollapseFailure =
  /** Not a dust snapshot this can read: bad JSON, no single hex `state`, or state the ledger rejects. */
  | 'unreadable'
  /** The snapshot holds DUST UTXOs, and collapsing would drop the data backing them. */
  | 'owns-dust'
  /** A check on the collapsed state failed, so nothing was returned. */
  | 'unverified';

export class DustCollapseError extends Error {
  constructor(
    readonly reason: DustCollapseFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DustCollapseError';
  }
}

/** What a dust snapshot holds, read through the ledger rather than guessed from bytes. */
export interface DustSnapshotSummary {
  stateBytes: number;
  utxos: number;
  generationRoot: bigint | undefined;
  commitmentRoot: bigint | undefined;
  generationFirstFree: bigint;
  commitmentFirstFree: bigint;
  syncTime: Date;
}

export interface DustCollapseReport {
  /** False when the snapshot was already collapsed; the input is then returned unchanged. */
  changed: boolean;
  stateBytesBefore: number;
  stateBytesAfter: number;
  generationFirstFree: bigint;
  commitmentFirstFree: bigint;
  generationRoot: bigint | undefined;
  commitmentRoot: bigint | undefined;
}

export interface DustCollapseResult {
  /** The snapshot with only its `state` replaced — every other byte of the envelope is the input's. */
  json: string;
  report: DustCollapseReport;
}

const unreadable = (message: string) => new DustCollapseError('unreadable', message);
const unverified = (message: string) => new DustCollapseError('unverified', `${message} Nothing was returned.`);
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface LocatedState {
  hex: string;
  /** Offsets of the hex digits within the envelope string. */
  start: number;
  end: number;
  envelope: Record<string, unknown>;
}

const STATE_FIELD = /"state"\s*:\s*"([0-9a-fA-F]*)"/g;

/**
 * Find the envelope's `state` hex without re-serializing the envelope.
 *
 * The collapsed state is spliced back into the original string, so everything
 * else — `offset`, `publicKey`, key order, formatting — is carried byte-for-byte
 * rather than round-tripped through JSON.parse/stringify and trusted to come out
 * the same. That only works if the field is found unambiguously, so it must occur
 * exactly once and agree with what JSON.parse reads.
 */
function locateState(json: string): LocatedState {
  let envelope: unknown;
  try {
    envelope = JSON.parse(json);
  } catch (err) {
    throw unreadable(`The dust snapshot is not JSON: ${describe(err)}`);
  }
  if (typeof envelope !== 'object' || envelope === null || typeof (envelope as {state?: unknown}).state !== 'string') {
    throw unreadable('The dust snapshot has no string `state` field — is this a dust sync snapshot?');
  }
  const matches = [...json.matchAll(STATE_FIELD)];
  const hex = (envelope as {state: string}).state;
  if (matches.length !== 1 || matches[0][1] !== hex) {
    throw unreadable('The dust snapshot must carry exactly one hex `state` field.');
  }
  const [whole, digits] = matches[0];
  const start = (matches[0].index as number) + whole.length - 1 - digits.length;
  return {hex, start, end: start + digits.length, envelope: envelope as Record<string, unknown>};
}

function nibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  const lower = code | 32;
  if (lower >= 97 && lower <= 102) return lower - 87;
  return -1;
}

/** Hex to bytes, refusing rather than truncating on an odd length or a stray character. */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw unreadable(`The dust state is ${hex.length} hex digits — expected an even count.`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = nibble(hex.charCodeAt(i * 2));
    const lo = nibble(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) throw unreadable('The dust state contains non-hex characters.');
    out[i] = (hi << 4) | lo;
  }
  return out;
}

const HEX_PAIRS = Array.from({length: 256}, (_, byte) => byte.toString(16).padStart(2, '0'));

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX_PAIRS[byte];
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function deserialize(bytes: Uint8Array, reason: DustCollapseFailure): ledger.DustLocalState {
  try {
    return ledger.DustLocalState.deserialize(bytes);
  } catch (err) {
    const message = `The dust state does not deserialize: ${describe(err)}`;
    throw reason === 'unverified' ? unverified(message) : new DustCollapseError(reason, message);
  }
}

// Values for inserts that exist only to be refused or discarded. They never reach
// a state anyone keeps.
const PROBE_GENERATION: ledger.DustGenerationInfo = {value: 0n, owner: 0n, nonce: '00'.repeat(32), dtime: undefined};
const probeOutput = (mtIndex: bigint): ledger.QualifiedDustOutput => ({
  initialValue: 0n,
  owner: 0n,
  nonce: 0n,
  seq: 0,
  ctime: new Date(0),
  backingNight: '00'.repeat(32),
  mtIndex,
});

const FRONTIER_REFUSAL = /expected to insert index (\d+)/;

/**
 * A tree's first free index: how many leaves it has been given.
 *
 * WORKAROUND for ledger-v8 8.1.x, which has no getter for this. ledger-v9 exposes
 * `generatingTreeFirstFree` and `commitmentTreeFirstFree`, and they are used
 * whenever the loaded ledger has them. On 8.1.x the number is read out of the
 * ledger's own refusal: both inserts check linearity before they look at the
 * value, so inserting at index 0 into a non-empty tree fails with "expected to
 * insert index N". That is an error message standing in for an API. It is
 * contained here, and pinned by a test that states it is a workaround, so a ledger
 * that rewords the message fails that test instead of quietly disabling the
 * collapse everywhere it runs.
 *
 * The collapse checks its own result against this number from both sides, so a
 * misread frontier is refused, never used.
 */
export function treeFrontier(state: ledger.DustLocalState, tree: 'generation' | 'commitment'): bigint {
  const property = tree === 'generation' ? 'generatingTreeFirstFree' : 'commitmentTreeFirstFree';
  const exposed = (state as unknown as Record<string, unknown>)[property];
  if (typeof exposed === 'bigint') return exposed;

  try {
    // Accepted only by an empty tree, where 0 is the frontier. The returned state is discarded.
    if (tree === 'generation') state.insertGenerationInfo(0n, PROBE_GENERATION);
    else state.insertCommitment(0n, probeOutput(0n), false);
  } catch (err) {
    const match = FRONTIER_REFUSAL.exec(describe(err));
    if (!match) {
      throw unverified(
        `Could not read the dust ${tree} tree's frontier: the ledger's refusal no longer says ` +
          `"expected to insert index N" (it said: ${describe(err)}). This ledger has changed the message the ` +
          `ledger-v8 8.1.x workaround reads — use its \`${property}\` property instead.`,
      );
    }
    return BigInt(match[1]);
  }
  return 0n;
}

interface Fingerprint {
  generationRoot: bigint | undefined;
  commitmentRoot: bigint | undefined;
  balance: bigint;
  utxos: number;
  syncTime: number;
}

function fingerprint(state: ledger.DustLocalState, now: Date): Fingerprint {
  return {
    generationRoot: state.generatingTreeRoot(),
    commitmentRoot: state.commitmentTreeRoot(),
    balance: state.walletBalance(now),
    utxos: state.utxos.length,
    syncTime: state.syncTime.getTime(),
  };
}

function expectUnchanged(stage: string, before: Fingerprint, after: Fingerprint): void {
  for (const key of Object.keys(before) as (keyof Fingerprint)[]) {
    if (before[key] !== after[key]) {
      throw unverified(`${stage} changed the dust state's ${key}: ${String(before[key])} -> ${String(after[key])}.`);
    }
  }
}

/** The root after inserting the next leaf, so two states can be compared at their frontier. */
function rootAfterAppend(state: ledger.DustLocalState, tree: 'generation' | 'commitment', at: bigint): bigint | undefined {
  try {
    return tree === 'generation'
      ? state.insertGenerationInfo(at, PROBE_GENERATION).generatingTreeRoot()
      : state.insertCommitment(at, probeOutput(at), false).commitmentTreeRoot();
  } catch (err) {
    throw unverified(`Appending to the dust ${tree} tree at its frontier (${at}) was refused: ${describe(err)}.`);
  }
}

/** Read a dust snapshot through the ledger: size, ownership, roots and frontiers. */
export function inspectDustSnapshot(json: string): DustSnapshotSummary {
  const bytes = hexToBytes(locateState(json).hex);
  const state = deserialize(bytes, 'unreadable');
  return {
    stateBytes: bytes.byteLength,
    utxos: state.utxos.length,
    generationRoot: state.generatingTreeRoot(),
    commitmentRoot: state.commitmentTreeRoot(),
    generationFirstFree: treeFrontier(state, 'generation'),
    commitmentFirstFree: treeFrontier(state, 'commitment'),
    syncTime: state.syncTime,
  };
}

/**
 * Collapse the populated range of a dust snapshot's generation and commitment
 * trees, and prove the result means the same thing.
 *
 * Checks, in order, and throws `DustCollapseError` at the first that fails:
 *
 * - the envelope carries exactly one hex `state`, and the ledger can read it
 * - the state owns no DUST
 * - collapsing leaves the roots, balance, UTXO count and sync time unchanged
 * - the collapsed state is no larger, survives serialize -> deserialize with
 *   the same values and the same frontiers
 * - appending the next leaf at each frontier gives the same root on the original
 *   and the collapsed state, which is what later sync actually does to it
 * - the rewritten envelope differs from the input only in `state`
 *
 * Idempotent: an already-collapsed snapshot comes back byte-for-byte, with
 * `changed: false`.
 */
export function collapseDustReference(json: string, now: Date = new Date()): DustCollapseResult {
  const located = locateState(json);
  const beforeBytes = hexToBytes(located.hex);
  const state = deserialize(beforeBytes, 'unreadable');

  const owned = state.utxos.length;
  if (owned > 0) {
    throw new DustCollapseError(
      'owns-dust',
      `This dust snapshot holds ${owned} UTXO(s). Collapsing drops the generation data backing them, and on ` +
        'ledger-v8 8.1.x the next balance read panics. Only a wallet that owns no DUST — the pre-seed reference — ' +
        'can be collapsed.',
    );
  }

  const before = fingerprint(state, now);
  const generationFirstFree = treeFrontier(state, 'generation');
  const commitmentFirstFree = treeFrontier(state, 'commitment');

  let collapsed = state;
  try {
    // Exactly the populated prefix. A range past the frontier materialises nodes
    // instead of removing them, and collapsing the frontier itself leaves the next
    // insert nowhere to go.
    if (generationFirstFree > 0n) collapsed = collapsed.collapseGenerationTree(0n, generationFirstFree - 1n);
    if (commitmentFirstFree > 0n) collapsed = collapsed.collapseCommitmentTree(0n, commitmentFirstFree - 1n);
  } catch (err) {
    throw unverified(`The ledger refused to collapse the dust trees: ${describe(err)}.`);
  }
  expectUnchanged('Collapsing', before, fingerprint(collapsed, now));

  const afterBytes = collapsed.serialize();
  if (afterBytes.byteLength > beforeBytes.byteLength) {
    throw unverified(`Collapsing grew the dust state from ${beforeBytes.byteLength} to ${afterBytes.byteLength} bytes.`);
  }

  // Through deserialize, the call every restore makes: "it collapsed" and "the
  // collapsed form survives serialization" are different claims, and only the
  // second one ships.
  const reloaded = deserialize(afterBytes, 'unverified');
  expectUnchanged('The serialize round trip', before, fingerprint(reloaded, now));
  const reloadedGeneration = treeFrontier(reloaded, 'generation');
  const reloadedCommitment = treeFrontier(reloaded, 'commitment');
  if (reloadedGeneration !== generationFirstFree || reloadedCommitment !== commitmentFirstFree) {
    throw unverified(
      `The collapsed state's frontiers moved: generation ${generationFirstFree} -> ${reloadedGeneration}, ` +
        `commitment ${commitmentFirstFree} -> ${reloadedCommitment}.`,
    );
  }

  // The frontier is what later sync appends at, so show that the next leaf lands
  // on the same root either way. A collapse that ate the frontier shows up here.
  for (const [tree, at] of [['generation', generationFirstFree], ['commitment', commitmentFirstFree]] as const) {
    const original = rootAfterAppend(state, tree, at);
    const rewritten = rootAfterAppend(reloaded, tree, at);
    if (original !== rewritten) {
      throw unverified(`Appending to the ${tree} tree at ${at} gives a different root before (${original}) and after (${rewritten}) collapsing.`);
    }
  }

  const report: DustCollapseReport = {
    changed: !sameBytes(beforeBytes, afterBytes),
    stateBytesBefore: beforeBytes.byteLength,
    stateBytesAfter: afterBytes.byteLength,
    generationFirstFree,
    commitmentFirstFree,
    generationRoot: before.generationRoot,
    commitmentRoot: before.commitmentRoot,
  };
  if (!report.changed) return {json, report};

  const rewritten = json.slice(0, located.start) + bytesToHex(afterBytes) + json.slice(located.end);
  const relocated = locateState(rewritten);
  if (JSON.stringify({...located.envelope, state: ''}) !== JSON.stringify({...relocated.envelope, state: ''})) {
    throw unverified('Rewriting the state changed another field of the dust snapshot envelope.');
  }
  return {json: rewritten, report};
}

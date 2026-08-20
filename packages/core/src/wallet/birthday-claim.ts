/**
 * Resolve what a user asserts about an imported seed's history into a height.
 *
 * Shared by the CLI, TUI and extension so the rules cannot drift between them:
 * the same four ways to say it, the same chain check, and the same warning about
 * what cannot be checked.
 */
import {firstUnshieldedActivity, type FirstActivity} from '../network/first-activity.js';
import {heightForDate} from '../network/block-time.js';
import {deriveAllAddressesFromSeed} from './address.js';

/**
 * What the user asserts about an imported seed's history.
 *
 * Absent means unknown, which is the safe answer: the sync scans from genesis.
 */
export type BirthdayClaim =
  | {kind: 'tip'}
  | {kind: 'date'; value: string}
  | {kind: 'height'; value: number}
  | {kind: 'discover'};

export interface BirthdayResolution {
  /** The height to store, or undefined for "no birthday, scan from genesis". */
  readonly height?: number;
  /** What the chain says about this seed, when the query ran. */
  readonly firstActivity?: FirstActivity | null;
  /** Messages to show the user — caveats and check results, in order. */
  readonly notes: string[];
  /**
   * Set when the claim is provably too late: the indexer holds a transaction
   * below it. Callers refuse unless the user explicitly overrides.
   */
  readonly conflict?: {readonly firstActivityHeight: number; readonly message: string};
}

/**
 * The caveat that applies to every discovered birthday.
 *
 * Shielded coins are located by trial-decrypting outputs with a viewing key, so
 * there is no address for the indexer to index and no query that can rule out
 * earlier shielded history. The failure is silent — a smaller balance, no error
 * — which is why this is said every time rather than left to documentation.
 */
export function shieldedCaveat(height: number): string {
  return (
    `This covers UNSHIELDED history only. If this seed received SHIELDED funds before block ${height}, ` +
    'those coins will not be found: the sync starts above them, the balance simply looks smaller, and nothing ' +
    'reports an error. Shielded coins are located by trial-decrypting outputs with your viewing key, so no ' +
    'address-based query can rule this out. If that is possible, assert a date you are sure predates every ' +
    "receive, or import with no birthday and take the full scan. Nothing is lost either way — clearing the " +
    "account's sync cache rescans and recovers them."
  );
}

/** The unshielded address a birthday check applies to, if derivable. */
function addressFor(seedHex: string | undefined, networkId: string): string | undefined {
  if (!seedHex) return undefined;
  try {
    return deriveAllAddressesFromSeed(seedHex).nightExternal.bech32m[networkId];
  } catch {
    return undefined;
  }
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function resolveBirthdayClaim(opts: {
  readonly indexerUrl: string;
  readonly networkId: string;
  readonly claim?: BirthdayClaim;
  /** Needed for 'discover' and for verifying an asserted claim. */
  readonly seedHex?: string;
  readonly tipHeight?: number;
  /**
   * Check an asserted claim against the chain. On by default: the check is one
   * round trip and turns a silent loss of funds into a refusal.
   */
  readonly verify?: boolean;
}): Promise<BirthdayResolution> {
  const {indexerUrl, networkId, claim, seedHex, tipHeight} = opts;
  const notes: string[] = [];
  if (!claim) return {notes};

  if (claim.kind === 'discover') {
    const address = addressFor(seedHex, networkId);
    if (!address) {
      throw new Error(`Cannot discover a birthday without a seed and an unshielded address for "${networkId}"`);
    }
    const found = await firstUnshieldedActivity(indexerUrl, address);

    if (found === null) {
      // Never seen on this chain, so the tip is a sound birthday for unshielded
      // — and still says nothing about shielded, hence the same caveat.
      if (tipHeight === undefined) {
        throw new Error(
          'The indexer reports no unshielded history for this seed, but no chain tip could be read to use instead',
        );
      }
      notes.push(`No unshielded transactions for this seed on ${networkId}; using the chain tip (${tipHeight}).`);
      notes.push(shieldedCaveat(tipHeight));
      return {height: tipHeight, firstActivity: null, notes};
    }

    notes.push(`First unshielded transaction at block ${found.height} (${isoDay(found.timestamp)}).`);
    notes.push(shieldedCaveat(found.height));
    return {height: found.height, firstActivity: found, notes};
  }

  let height: number | undefined;
  if (claim.kind === 'tip') {
    height = tipHeight;
  } else if (claim.kind === 'height') {
    height = claim.value > 0 ? claim.value : undefined;
  } else {
    // A date lands on the last block strictly before it, because too early only
    // costs sync time while too late hides funds.
    height = (await heightForDate(indexerUrl, new Date(claim.value))).height;
  }
  if (height === undefined) return {notes};

  if (opts.verify === false) return {height, notes};

  const address = addressFor(seedHex, networkId);
  if (!address) return {height, notes};

  let found: FirstActivity | null;
  try {
    found = await firstUnshieldedActivity(indexerUrl, address);
  } catch (err) {
    // An unreachable indexer must not block an import, but the caller has to be
    // able to say the check did not run rather than imply it passed.
    notes.push(`Could not check this birthday against the chain (${err}). It is unverified.`);
    return {height, notes};
  }

  if (found === null || found.height >= height) {
    if (found !== null) {
      notes.push(`Checked: earliest unshielded transaction is at block ${found.height}, at or above this birthday.`);
    }
    return {height, firstActivity: found, notes};
  }

  return {
    height,
    firstActivity: found,
    notes,
    conflict: {
      firstActivityHeight: found.height,
      message:
        `this seed already has an unshielded transaction at block ${found.height} ` +
        `(${isoDay(found.timestamp)}), below the birthday asserted (${height}). Syncing from ${height} would ` +
        'start above it, so those funds would not be found.',
    },
  };
}

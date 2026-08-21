// Mapping a wall-clock instant to a block height.
//
// Exists so a user importing a wallet can assert "this seed had no activity
// before <date>" and get a pre-seed instead of a walk from genesis. Moth cannot
// infer that itself: an imported seed may hold funds on any chain at any height,
// which is why `createdHere` gates automatic birthdays. This is the explicit
// route alongside it, not a replacement for it.
//
// The asymmetry decides the rounding. Naming a height that is too early costs a
// slower sync; too late and funds before it never appear. So the search returns
// the last block STRICTLY BEFORE the target, and clamps to the first block
// rather than returning nothing.

/** Reads a block by height. Returns null for a height the chain has no block at. */
export type BlockAt = (height: number) => Promise<{height: number; timestamp: number} | null>;

export interface HeightAtTime {
  readonly height: number;
  readonly timestamp: number;
}

/**
 * The last block strictly before `targetMs`, by binary search over heights.
 *
 * Logarithmic in chain length — roughly 21 lookups on a 2M-block chain — which
 * is what makes this cheap enough to run during an import.
 */
export async function findHeightBefore(
  blockAt: BlockAt,
  tipHeight: number,
  targetMs: number,
): Promise<HeightAtTime> {
  const first = await firstReadable(blockAt, tipHeight);
  if (!first) throw new Error('Chain has no readable blocks');
  if (first.timestamp >= targetMs) return first;

  let lo = first.height;
  let hi = tipHeight;
  let best = first;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const block = await readNear(blockAt, mid, hi);
    if (!block) {
      // Nothing readable from mid upwards; the answer is below.
      hi = mid - 1;
      continue;
    }
    if (block.timestamp < targetMs) {
      best = block;
      lo = block.height + 1;
    } else {
      hi = block.height - 1;
    }
  }
  return best;
}

/** Blocks can be absent at a given height; step forward a little to find one. */
async function readNear(blockAt: BlockAt, from: number, limit: number): Promise<HeightAtTime | null> {
  for (let h = from; h <= Math.min(from + 8, limit); h += 1) {
    const block = await blockAt(h);
    if (block) return block;
  }
  return null;
}

async function firstReadable(blockAt: BlockAt, tipHeight: number): Promise<HeightAtTime | null> {
  for (let h = 1; h <= Math.min(16, tipHeight); h += 1) {
    const block = await blockAt(h);
    if (block) return block;
  }
  return null;
}

/** Current chain tip, or null if the indexer cannot be reached. */
export async function chainTip(indexerUrl: string): Promise<HeightAtTime | null> {
  const {IndexerClient} = await import('./indexer-client.js');
  const block = await new IndexerClient(indexerUrl).getBlock();
  return block ? {height: block.height, timestamp: block.timestamp} : null;
}

/**
 * The last block before `when`, read from a real indexer.
 *
 * Roughly 21 lookups on a 2M-block chain, so it is cheap enough to run inline
 * during an import rather than needing a background job.
 */
export async function heightForDate(indexerUrl: string, when: Date): Promise<HeightAtTime> {
  const {IndexerClient} = await import('./indexer-client.js');
  const client = new IndexerClient(indexerUrl);
  const tip = await client.getBlock();
  if (!tip) throw new Error(`Could not read a chain tip from ${indexerUrl}`);
  const blockAt: BlockAt = async (height) => {
    const block = await client.getBlock({height});
    return block ? {height: block.height, timestamp: block.timestamp} : null;
  };
  return findHeightBefore(blockAt, tip.height, when.getTime());
}

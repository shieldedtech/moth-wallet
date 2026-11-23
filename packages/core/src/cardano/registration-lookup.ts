// Finding one stake key's DUST registrations among everyone's.
//
// Every registration on a network sits at the same validator address under the
// same auth NFT, and only the datum says whose it is, so all of them have to be
// read: over 4,000 on mainnet. Asking Lucid for them took over six minutes, not
// because of the requests (43 pages, seconds) but because its Blockfrost
// provider converts results with a fixed pause, 0.5 s every 10 UTXOs and 5 s
// every 100, whether or not it makes any request.
//
// So the pages are read here, a few at a time, and each inline datum is decoded
// straight from the response. Only the outputs that carry this stake key go back
// to Lucid, which needs its own UTxO shape to spend them.

import { datumStakeKeyHash, decodeDustMappingDatum } from './datum.js';
import type { CardanoNetworkConfig } from './network.js';

export interface OutRef {
  readonly txHash: string;
  readonly outputIndex: number;
}

export interface RegistrationLookupOptions {
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Per-request limit; a request that never answers would hold the screen open. */
  timeoutMs?: number;
  /** Pages in flight at once. Blockfrost's free tier allows 10 requests per second. */
  concurrency?: number;
}

/** Blockfrost's largest page. */
const PAGE = 100;

interface BlockfrostUtxo {
  tx_hash: string;
  output_index: number;
  inline_datum?: string | null;
}

/**
 * Out-refs of the registrations at `validatorAddress` whose datum names
 * `stakeKeyHash`. Throws when Blockfrost cannot answer, so a failed read is
 * never reported as "not registered".
 */
export async function registrationOutRefs(
  config: CardanoNetworkConfig,
  validatorAddress: string,
  authUnit: string,
  stakeKeyHash: string,
  opts: RegistrationLookupOptions = {},
): Promise<OutRef[]> {
  if (!config.blockfrostProjectId) throw new Error('No Blockfrost project ID is configured.');
  const projectId = config.blockfrostProjectId;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const concurrency = Math.max(1, opts.concurrency ?? 5);

  /** One page; null past the end (Blockfrost answers 404 for an address it has never seen). */
  async function page(n: number): Promise<BlockfrostUtxo[] | null> {
    const path = `/addresses/${validatorAddress}/utxos/${authUnit}?page=${n}&count=${PAGE}`;
    const response = await doFetch(`${config.blockfrostUrl}${path}`, {
      headers: { project_id: projectId },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Blockfrost answered ${response.status} reading DUST registrations`);
    return (await response.json()) as BlockfrostUtxo[];
  }

  const matches: OutRef[] = [];
  const collect = (utxos: BlockfrostUtxo[]) => {
    for (const utxo of utxos) {
      if (!utxo.inline_datum) continue;
      try {
        if (datumStakeKeyHash(decodeDustMappingDatum(utxo.inline_datum)) !== stakeKeyHash) continue;
      } catch {
        continue; // not every output parked at this address has to be a registration datum
      }
      matches.push({ txHash: utxo.tx_hash, outputIndex: utxo.output_index });
    }
  };

  // The page count is unknown up front, so pages go out in rounds and the first
  // short page ends the read.
  for (let start = 1; ; start += concurrency) {
    const round = await Promise.all(Array.from({ length: concurrency }, (_, i) => page(start + i)));
    for (const utxos of round) if (utxos) collect(utxos);
    if (round.some((utxos) => utxos === null || utxos.length < PAGE)) return matches;
  }
}

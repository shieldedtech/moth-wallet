import type { UTxO } from '@lucid-evolution/lucid';
import { NetworkError } from '../types/errors.js';
import type { CardanoNetworkConfig } from './network.js';
import { BlockfrostKeyMissingError } from './session.js';

/** The fields of a Blockfrost address UTXO that moth reads. */
export interface BlockfrostUtxo {
  readonly tx_hash: string;
  readonly output_index: number;
  readonly address: string;
  readonly amount: ReadonlyArray<{ readonly unit: string; readonly quantity: string }>;
  readonly data_hash: string | null;
  readonly inline_datum: string | null;
  readonly reference_script_hash: string | null;
}

/**
 * Lucid's UTxO for a Blockfrost row, built the way Lucid's own provider builds
 * it. A reference script is left out: only its hash is in the row.
 */
export function blockfrostUtxoToUtxo(row: BlockfrostUtxo): UTxO {
  return {
    txHash: row.tx_hash,
    outputIndex: row.output_index,
    address: row.address,
    assets: Object.fromEntries(row.amount.map(({ unit, quantity }) => [unit, BigInt(quantity)])),
    datumHash: (!row.inline_datum && row.data_hash) || undefined,
    datum: row.inline_datum ?? undefined,
  };
}

/** Blockfrost's largest page. */
const PAGE_SIZE = 100;
/** Pages requested at once: a full mainnet scan stays inside Blockfrost's burst allowance. */
const PARALLEL_PAGES = 8;
const RATE_LIMIT_RETRIES = 3;

/**
 * Every UTXO at `address` holding `unit`, read straight from Blockfrost.
 *
 * Lucid's `utxosAtWithUnit` fetches these pages one at a time and then sleeps
 * 500 ms per ten UTXOs while converting them, which on an address with
 * thousands of UTXOs takes minutes. This fetches pages in parallel and leaves
 * the rows raw, for callers to convert only the ones they keep.
 */
export async function fetchUtxosWithUnit(
  config: CardanoNetworkConfig,
  address: string,
  unit: string,
): Promise<BlockfrostUtxo[]> {
  const utxos: BlockfrostUtxo[] = [];
  for (let first = 1; ; first += PARALLEL_PAGES) {
    const pages = await Promise.all(
      Array.from({ length: PARALLEL_PAGES }, (_, i) =>
        fetchPage(config, `/addresses/${address}/utxos/${unit}`, first + i),
      ),
    );
    for (const page of pages) utxos.push(...page);
    if (pages.some((page) => page.length < PAGE_SIZE)) return utxos;
  }
}

async function fetchPage(
  config: CardanoNetworkConfig,
  path: string,
  page: number,
): Promise<BlockfrostUtxo[]> {
  const projectId = config.blockfrostProjectId;
  if (!projectId) throw new BlockfrostKeyMissingError();
  const url = `${config.blockfrostUrl}${path}?count=${PAGE_SIZE}&page=${page}`;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, { headers: { project_id: projectId } });
    } catch (err) {
      throw new NetworkError(`Could not reach Blockfrost at ${config.blockfrostUrl}.`, err);
    }
    // Blockfrost answers 404 for an address it has never seen, which holds nothing.
    if (response.status === 404) return [];
    if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      throw new NetworkError(`Blockfrost answered ${response.status} while listing UTXOs.`);
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new NetworkError('Blockfrost returned an unexpected UTXO page.');
    return body as BlockfrostUtxo[];
  }
}

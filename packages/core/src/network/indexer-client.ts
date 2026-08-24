import { NetworkError } from '../types/errors.js';

export interface Block {
  hash: string;
  height: number;
  timestamp: number;
  protocolVersion: number;
  /**
   * Per-block ends of the dust commitment and generation sequences, and of the
   * zswap one. Requested only by `getBlockCursors` — they are the closest thing
   * the indexer exposes to "where in the event streams does this block sit",
   * which is what building a reference at a chosen height needs.
   */
  dustCommitmentEndIndex?: number;
  dustGenerationEndIndex?: number;
  zswapEndIndex?: number;
}

export interface ContractAction {
  address: string;
  state: string;
  zswapState: string;
  entryPoint?: string;
  unshieldedBalances: Array<{ tokenType: string; amount: string }>;
  transaction: { hash: string; id: number };
  block: { hash: string; height: number };
}

export interface DustGenerationStatus {
  cardanoRewardAddress: string;
  dustAddress: string | null;
  registered: boolean;
  nightBalance: string;
  generationRate: string;
  maxCapacity: string;
  currentCapacity: string;
}

export interface TransactionInfo {
  id: number;
  hash: string;
  protocolVersion: number;
  raw: string;
  block: Block;
}

export class IndexerClient {
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async getBlock(offset?: { hash?: string; height?: number }): Promise<Block | null> {
    const query = `
      query ($offset: BlockOffset) {
        block(offset: $offset) {
          hash height timestamp protocolVersion
        }
      }
    `;
    const result = await this.query<{ block: Block | null }>(query, { offset: offset ?? null });
    return result.block;
  }

  /**
   * A block with its stream-position counters. Separate from `getBlock` so the
   * common path keeps its small selection set — these fields are only wanted
   * when locating a height within the dust event stream.
   */
  async getBlockCursors(height: number): Promise<Block | null> {
    const query = `
      query ($offset: BlockOffset) {
        block(offset: $offset) {
          hash height timestamp protocolVersion
          dustCommitmentEndIndex dustGenerationEndIndex zswapEndIndex
        }
      }
    `;
    const result = await this.query<{ block: Block | null }>(query, { offset: { height } });
    return result.block;
  }

  async getTransactions(offset: { hash?: string; identifier?: string }): Promise<TransactionInfo[]> {
    const query = `
      query ($offset: TransactionOffset!) {
        transactions(offset: $offset) {
          id hash protocolVersion raw
          block { hash height timestamp protocolVersion }
        }
      }
    `;
    const result = await this.query<{ transactions: TransactionInfo[] }>(query, { offset });
    return result.transactions;
  }

  async getContractAction(
    address: string,
    offset?: { blockOffset?: { hash?: string; height?: number }; transactionOffset?: { hash?: string } },
  ): Promise<ContractAction | null> {
    const query = `
      query ($address: HexEncoded!, $offset: ContractActionOffset) {
        contractAction(address: $address, offset: $offset) {
          address state zswapState
          ... on ContractCall { entryPoint }
          unshieldedBalances { tokenType amount }
          transaction { hash }
          ... on ContractDeploy { transaction { hash } }
          ... on ContractCall { transaction { hash } deploy { address } }
        }
      }
    `;
    const result = await this.query<{ contractAction: ContractAction | null }>(query, {
      address,
      offset: offset ?? null,
    });
    return result.contractAction;
  }

  async getDustGenerationStatus(cardanoRewardAddresses: string[]): Promise<DustGenerationStatus[]> {
    const query = `
      query ($addresses: [CardanoRewardAddress!]!) {
        dustGenerationStatus(cardanoRewardAddresses: $addresses) {
          cardanoRewardAddress dustAddress registered
          nightBalance generationRate maxCapacity currentCapacity
        }
      }
    `;
    const result = await this.query<{ dustGenerationStatus: DustGenerationStatus[] }>(query, {
      addresses: cardanoRewardAddresses,
    });
    return result.dustGenerationStatus;
  }

  async connect(viewingKey: string): Promise<string> {
    const query = `mutation ($viewingKey: ViewingKey!) { connect(viewingKey: $viewingKey) }`;
    const result = await this.query<{ connect: string }>(query, { viewingKey });
    return result.connect;
  }

  async disconnect(sessionId: string): Promise<void> {
    const query = `mutation ($sessionId: HexEncoded!) { disconnect(sessionId: $sessionId) }`;
    await this.query(query, { sessionId });
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new NetworkError(`Indexer request failed: HTTP ${response.status}`);
      }

      const json = await response.json() as Record<string, unknown>;

      // SR-002: Validate GraphQL response structure before acting on data
      if (typeof json !== 'object' || json === null) {
        throw new NetworkError('Indexer response is not a valid JSON object');
      }
      const errors = json.errors as Array<{ message: string }> | undefined;
      if (Array.isArray(errors) && errors.length > 0) {
        throw new NetworkError(`Indexer error: ${errors[0]?.message ?? 'unknown'}`);
      }
      if (!('data' in json)) {
        throw new NetworkError('Indexer response missing data field');
      }
      return json.data as T;
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NetworkError(`Indexer timeout after 10s to ${this.url}`);
      }
      throw new NetworkError(`Indexer query failed: ${err}`, err);
    } finally {
      clearTimeout(timeout);
    }
  }
}

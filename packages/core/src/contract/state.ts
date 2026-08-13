import { IndexerClient, type ContractAction } from '../network/indexer-client.js';

export interface ContractState {
  address: string;
  state: string;
  zswapState: string;
  entryPoint?: string;
  unshieldedBalances: Array<{ tokenType: string; amount: string }>;
  lastUpdated: { blockHash: string; blockHeight: number } | null;
}

export async function queryContractState(
  indexerUrl: string,
  contractAddress: string,
): Promise<ContractState | null> {
  const client = new IndexerClient(indexerUrl);
  const action = await client.getContractAction(contractAddress);

  if (!action) return null;

  return {
    address: action.address,
    state: action.state,
    zswapState: action.zswapState,
    entryPoint: action.entryPoint,
    unshieldedBalances: action.unshieldedBalances,
    lastUpdated: action.block
      ? { blockHash: action.block.hash, blockHeight: action.block.height }
      : null,
  };
}

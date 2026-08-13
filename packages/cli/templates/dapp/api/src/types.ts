/**
 * Union of impure circuit names exported by the contract.
 * Replace with actual circuit names after connecting a compiled contract.
 */
export type ImpureCircuitKeys = string;

/**
 * Contract deployment configuration.
 */
export type ProverConfig =
  | { type: 'server'; url: string }
  | { type: 'wasm' };

export interface DeployConfig {
  /** Indexer GraphQL URL */
  indexerUrl: string;
  /** Indexer WebSocket URL */
  indexerWsUrl: string;
  /** Node WebSocket URL */
  nodeUrl: string;
  /** Proof generation configuration */
  prover: ProverConfig;
}

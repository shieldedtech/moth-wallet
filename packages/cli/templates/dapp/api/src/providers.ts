import type { DeployConfig } from './types.js';

/**
 * SDK providers needed for contract interaction.
 * Fill in after connecting a compiled contract.
 */
export interface ContractProviders {
  // TODO: Add your provider types here after connecting a contract.
  // Example:
  // publicDataProvider: ...
  // privateStateProvider: ...
  // zkConfigProvider: ...
  // proofProvider: ...
}

/**
 * Create the set of providers for contract deployment and interaction.
 */
export function createProviders(_config: DeployConfig): ContractProviders {
  // TODO: Implement after connecting a contract.
  // See: https://docs.midnight.network/develop/tutorial/building/providers
  throw new Error('Not implemented — connect a compiled contract first');
}

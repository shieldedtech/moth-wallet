import type {NetworkConfig} from '../types/network.js';
import {NetworkError} from '../types/errors.js';

export interface NodeClient {
  connect(config: NetworkConfig): Promise<void>;
  disconnect(): Promise<void>;
  getBlockHeight(): Promise<number>;
  getGenesisHash(): Promise<string>;
  isConnected(): boolean;
}

/**
 * Minimal JSON-RPC client for read-only chain status queries
 * (block height, genesis hash, ledger version, contract state).
 * Transaction submission is handled by @midnightntwrk/wallet-sdk-node-client
 * via createMidnightProvider.
 */
export class JsonRpcNodeClient implements NodeClient {
  private nodeUrl = '';
  private connected = false;

  async connect(config: NetworkConfig): Promise<void> {
    this.nodeUrl = config.nodeUrl.replace('ws://', 'http://').replace('wss://', 'https://');
    // Verify connectivity with a simple RPC call
    try {
      await this.rpcCall('system_health', []);
      this.connected = true;
    } catch (err) {
      throw new NetworkError(`Could not connect to node at ${config.nodeUrl}`, err);
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getBlockHeight(): Promise<number> {
    const header = await this.rpcCall<{number: string}>('chain_getHeader', []);
    return parseInt(header.number, 16);
  }

  async getGenesisHash(): Promise<string> {
    return this.rpcCall<string>('chain_getBlockHash', [0]);
  }

  async getContractState(address: string): Promise<string | null> {
    try {
      return await this.rpcCall<string>('midnight_contractState', [address]);
    } catch {
      return null;
    }
  }

  async getLedgerVersion(): Promise<string> {
    return this.rpcCall<string>('midnight_ledgerVersion', []);
  }

  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(this.nodeUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new NetworkError(`RPC request failed: HTTP ${response.status}`);
      }

      const json = (await response.json()) as Record<string, unknown>;

      // SR-002: Validate RPC response structure before acting on data
      if (typeof json !== 'object' || json === null) {
        throw new NetworkError(`RPC response is not a valid JSON object`);
      }
      if (json.jsonrpc !== '2.0') {
        throw new NetworkError(`RPC response missing jsonrpc 2.0 field`);
      }
      if (json.error) {
        const err = json.error as {message?: string};
        throw new NetworkError(`RPC error: ${err.message ?? 'unknown'}`);
      }
      if (!('result' in json)) {
        throw new NetworkError(`RPC response missing result field for method ${method}`);
      }
      return json.result as T;
    } catch (err) {
      if (err instanceof NetworkError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NetworkError(`Connection timeout after 10s to ${this.nodeUrl}`);
      }
      throw new NetworkError(`RPC call failed: ${err}`, err);
    } finally {
      clearTimeout(timeout);
    }
  }
}

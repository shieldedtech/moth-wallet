import { ProofError, NetworkError } from '../types/errors.js';

export interface ProofServerStatus {
  healthy: boolean;
  jobsProcessing: number;
  jobsPending: number;
  jobCapacity: number;
}

export class ProofClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(url: string, timeoutMs = 300_000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async healthCheck(): Promise<ProofServerStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const response = await fetch(`${this.url}/ready`, {
        signal: controller.signal,
      });

      if (response.status === 503) {
        const json = await response.json() as ProofServerStatus;
        return { ...json, healthy: false };
      }

      if (!response.ok) {
        throw new ProofError(`Proof server returned HTTP ${response.status}`);
      }

      const json = await response.json() as ProofServerStatus;
      return { ...json, healthy: true };
    } catch (err) {
      if (err instanceof ProofError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NetworkError(
          `Proof server not reachable at ${this.url}. Start with: moth proof-server start`,
        );
      }
      throw new NetworkError(
        `Proof server not reachable at ${this.url}. Start with: moth proof-server start`,
        err,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async ensureReady(): Promise<void> {
    const status = await this.healthCheck();
    if (!status.healthy) {
      throw new ProofError(
        `Proof server at ${this.url} is busy (${status.jobsProcessing} jobs processing, ${status.jobsPending} pending)`,
      );
    }
  }

  // The raw `prove()` method (POST of a bare serialized transaction to /prove)
  // is deliberately gone: it predated payload versioning — ledger-v8 rejects
  // the unversioned circuit-call proofs it produced — and all proving now
  // flows through the SDK proof provider (see proof/provider.ts). Removed
  // rather than left exported so the old request format can't be wired back in.

  async check(preimage: Uint8Array): Promise<(bigint | undefined)[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}/check`, {
        method: 'POST',
        body: preimage as unknown as BodyInit,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new ProofError(`Proof check failed: ${text}`);
      }

      const buffer = await response.arrayBuffer();
      // Parse check result — format depends on ledger serialization
      // Placeholder: return raw bytes interpretation
      return [BigInt(new Uint8Array(buffer).length)];
    } catch (err) {
      if (err instanceof ProofError) throw err;
      throw new ProofError(`Proof check failed: ${err}`, err);
    } finally {
      clearTimeout(timeout);
    }
  }
}

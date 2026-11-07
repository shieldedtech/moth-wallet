import * as ledger from '@midnight-ntwrk/ledger-v8';
import type { KeyMaterialProvider } from '@midnight-ntwrk/midnight-js/types';
import type { ProofServerAttestation, ProverConfig } from '../types/network.js';

export type ServerProverConfig = Extract<ProverConfig, { readonly type: 'server' }>;

/** A proof-server connection whose quote already matched the stored pin. */
export interface AttestedChannel {
  check(body: Uint8Array): Promise<Uint8Array>;
  prove(body: Uint8Array): Promise<Uint8Array>;
  ready(): Promise<void>;
}

export interface AttestedSessionModule {
  openAttestedProofChannel(
    config: ServerProverConfig & { readonly attestation: ProofServerAttestation },
  ): Promise<AttestedChannel>;
}

interface CircuitPayloads {
  checkPayload(preimage: Uint8Array, keyLocation: string): Promise<Uint8Array>;
  provePayload(
    preimage: Uint8Array,
    keyLocation: string,
    overwriteBindingInput?: bigint,
  ): Promise<Uint8Array>;
}

/**
 * Circuit prover that posts `/check` and `/prove` only after `open` resolves.
 * `open` is the local attestation session. A rejection there returns before
 * either endpoint is called.
 */
export function boundProvingProvider(
  open: () => Promise<AttestedChannel>,
  payloads: CircuitPayloads,
): ledger.ProvingProvider {
  return {
    async check(serializedPreimage: Uint8Array, keyLocation: string): Promise<(bigint | undefined)[]> {
      const channel = await open();
      const body = await payloads.checkPayload(serializedPreimage, keyLocation);
      return ledger.parseCheckResult(await channel.check(body));
    },

    async prove(
      serializedPreimage: Uint8Array,
      keyLocation: string,
      overwriteBindingInput?: bigint,
    ): Promise<Uint8Array> {
      const channel = await open();
      const body = await payloads.provePayload(serializedPreimage, keyLocation, overwriteBindingInput);
      return channel.prove(body);
    },
  };
}

/** Wallet circuits. The proof server already has their keys, so the payload is the preimage alone. */
export function walletCircuitPayloads(): CircuitPayloads {
  return {
    checkPayload: (preimage) => Promise.resolve(ledger.createCheckPayload(preimage)),
    provePayload: (preimage, _keyLocation, overwriteBindingInput) =>
      Promise.resolve(ledger.createProvingPayload(preimage, overwriteBindingInput)),
  };
}

/**
 * Contract circuits. The payload carries the circuit keys, matching
 * midnight-js `httpClientProvingProvider`: the IR on `/check`, and the full
 * key material on `/prove`.
 */
export function contractCircuitPayloads(keys: KeyMaterialProvider): CircuitPayloads {
  return {
    async checkPayload(preimage, keyLocation) {
      let ir: Uint8Array | undefined;
      try {
        ir = await keys.getZKIR(keyLocation);
      } catch {
        ir = undefined;
      }
      return ledger.createCheckPayload(preimage, ir);
    },
    async provePayload(preimage, keyLocation, overwriteBindingInput) {
      let material: ledger.ProvingKeyMaterial | undefined;
      try {
        const [ir, proverKey, verifierKey] = await Promise.all([
          keys.getZKIR(keyLocation),
          keys.getProverKey(keyLocation),
          keys.getVerifierKey(keyLocation),
        ]);
        material = { ir, proverKey, verifierKey };
      } catch {
        material = undefined;
      }
      return ledger.createProvingPayload(preimage, overwriteBindingInput, material);
    },
  };
}

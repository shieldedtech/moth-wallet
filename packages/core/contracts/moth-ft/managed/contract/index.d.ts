import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  mintShielded(context: __compactRuntime.CircuitContext<PS>,
               recipient_0: { bytes: Uint8Array },
               value_0: bigint): __compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                       color: Uint8Array,
                                                                       value: bigint
                                                                     }>;
  mintUnshielded(context: __compactRuntime.CircuitContext<PS>,
                 recipient_0: { bytes: Uint8Array },
                 value_0: bigint): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type ProvableCircuits<PS> = {
  mintShielded(context: __compactRuntime.CircuitContext<PS>,
               recipient_0: { bytes: Uint8Array },
               value_0: bigint): __compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                       color: Uint8Array,
                                                                       value: bigint
                                                                     }>;
  mintUnshielded(context: __compactRuntime.CircuitContext<PS>,
                 recipient_0: { bytes: Uint8Array },
                 value_0: bigint): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type PureCircuits = {
  domainSep(): Uint8Array;
}

export type Circuits<PS> = {
  domainSep(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, Uint8Array>;
  mintShielded(context: __compactRuntime.CircuitContext<PS>,
               recipient_0: { bytes: Uint8Array },
               value_0: bigint): __compactRuntime.CircuitResults<PS, { nonce: Uint8Array,
                                                                       color: Uint8Array,
                                                                       value: bigint
                                                                     }>;
  mintUnshielded(context: __compactRuntime.CircuitContext<PS>,
                 recipient_0: { bytes: Uint8Array },
                 value_0: bigint): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type Ledger = {
  readonly nonce: Uint8Array;
  readonly mintCount: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;

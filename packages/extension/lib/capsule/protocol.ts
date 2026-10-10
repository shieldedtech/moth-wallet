// What crosses between the capsule runtime in the wallet worker and the rest of the extension: the
// account a request runs under, the consents the runtime asks, the events it emits, and what the
// inspector reads. Every value here is JSON: the offscreen → service worker hop is JSON, and the
// page transport is bigint-JSON over a string. The blueprint's own types are JSON already.
//
// IMPORTANT: no runtime imports. This module is read by the service worker, the offscreen page,
// the wallet worker and the injected page script alike.

import type { AnswersDocument, CapsuleView } from '@shieldedtech/capsule-core';
import type {
  CapsuleEvent,
  ConnectRequest,
  ConnectResult,
  DescribeRequest,
  ExecutableDescription,
  Json,
  ReadLocalStateRequest,
  ReadLocalStateResult,
  SubmitResult,
  TransactionBlueprint,
} from '@shieldedtech/capsule-blueprint';
import type { NetworkConfig } from '@shieldedtech/moth-browser';

/** The unlocked account a capsule request runs under, as every offscreen op carries it. */
export interface CapsuleAccount {
  seedHex: string;
  walletName: string;
  network: NetworkConfig;
}

/** A dApp's request: the account, and the origin the background took from the message sender. */
export interface CapsuleCall extends CapsuleAccount {
  origin: string;
}

/** The page-facing methods, relayed as `connectorRequest`s like the standard connector's. */
export const CAPSULE_METHODS = [
  'capsuleConnect',
  'capsuleDescribe',
  'capsuleSubmitBlueprint',
  'capsuleMakeTransaction',
  'capsuleEstimate',
  'capsuleReadLocalState',
  'capsuleWatch',
  'capsuleDisconnect',
] as const;
export type CapsuleMethod = (typeof CAPSULE_METHODS)[number];

/** What each method takes from the page and answers, in order of `params`. */
export interface CapsuleMethodMap {
  capsuleConnect: { params: [ConnectRequest]; result: ConnectResult };
  capsuleDescribe: { params: [string, DescribeRequest]; result: ExecutableDescription };
  capsuleSubmitBlueprint: { params: [string, TransactionBlueprint]; result: SubmitResult };
  capsuleMakeTransaction: { params: [string, TransactionBlueprint]; result: Json };
  capsuleEstimate: { params: [string, TransactionBlueprint]; result: Json };
  capsuleReadLocalState: { params: [string, ReadLocalStateRequest]; result: ReadLocalStateResult };
  /** Start (true) or stop (false) hearing a session's capsule events; delivered as `capsuleEvent` messages to the tab. */
  capsuleWatch: { params: [string, boolean]; result: null };
  /** Ends a session; the grants behind it stay, the user's to revoke in Connected sites. */
  capsuleDisconnect: { params: [string]; result: null };
}

/** The unlocked account's installed capabilities: its answers document, or the demo's when it has none of its own. */
export interface CapsuleCapabilitiesDTO {
  document: AnswersDocument;
  isDefault: boolean;
}

/** A site's standing with the capsule runtime under the unlocked account: each contract with what the site may do. */
export interface CapsuleSiteGrantsDTO {
  origin: string;
  contracts: Array<{ address: string; call: boolean; read: boolean }>;
}

/** One rendered argument as the runtime shows it: the value by its declared type beside the bytes the proof commits to. */
export interface CapsuleRenderedArgument {
  rendered: Json;
  bytes: { value: string[] };
}

/** A consent the runtime puts to the user, as the approval screen shows it. */
export type CapsuleConsentDTO =
  | {
      kind: 'capsuleConnect';
      origin: string;
      account: string;
      /** Absent when the dApp connects to the account alone, to deploy. */
      contract?: string;
      bundle?: string;
      fingerprint?: string;
    }
  | { kind: 'capsuleRead'; origin: string; account: string; contract: string; bundle: string; name: string }
  | {
      kind: 'capsuleTransaction';
      origin: string;
      account: string;
      calls: Array<{ contract: string; bundle: string; entrypoint: string; arguments: CapsuleRenderedArgument[] }>;
      /** Calls the asked call reached in other contracts; their arguments were the caller's. */
      reached: Array<{ contract: string; bundle: string; entrypoint: string }>;
      deploys: Array<{ bundle: string; fingerprint: string; address: string; arguments: CapsuleRenderedArgument[] }>;
      /** The installed capabilities the transaction's contracts are handed, by contract. */
      capabilities: Array<{ contract: string; bundle: string; interfaceId: string; functions: string[] }>;
      /** ISO 8601. */
      ttl: string;
    };

/** A capsule event for a session, from the worker to the tab that opened the session. */
export interface CapsuleEventDTO {
  session: string;
  event: CapsuleEvent;
}

/** A settlement under an account, from the worker to every open panel: the inspector re-reads on it. */
export interface CapsuleSettledDTO {
  walletName: string;
  networkId: string;
  identifier: string;
  status: 'success' | 'failure' | 'partial' | 'expired';
  /** The contracts whose capsules the settlement touched or deployed. */
  contracts: string[];
}

/**
 * The inspector's reading of an account's capsules and what is in flight. A capsule's view is the
 * runtime's own, JSON throughout: both states rendered, the interface, its history and its calls
 * in flight.
 */
/** The seed's sub-accounts — the MIP's accounts, numbered by the runtime and labelled by the user — and which is current. */
export interface CapsuleAccountsDTO {
  accounts: Array<{ number: number; label: string }>;
  current: number;
}

export interface CapsuleInspectorDTO {
  /** The sub-account these capsules belong to. */
  account: { number: number; label: string };
  capsules: CapsuleView[];
  pending: Array<{ identifier: string; calls: Array<{ address: string; circuit: string }>; submittedAt: string; ttl: string }>;
  /** Capsules folded on another chain (a reset network), set aside when the account opened on this one. */
  setAside?: { genesis: string; capsules: number; pending: number };
}

/** A capsule refusal as it crosses to the page: the blueprint's code, reason and path, nothing else. */
export interface CapsuleErrorDTO {
  code: string;
  reason: string;
  path?: Array<string | number>;
}

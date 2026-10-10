// The capsule runtime, inside the wallet worker beside the sync engine: one runtime per unlocked
// account on a network, over the synced wallet's own facade, with the executor behind the port the
// offscreen document transferred in, capsules and grants in this worker's IndexedDB, and one
// connector per dApp origin, which asks the user through the consent channel the worker entry
// wires to the background. Reached through host-dispatch, lazily: this module carries the ledger.

import {
  domEndpoint,
  type ConnectRequest,
  type DescribeRequest,
  type ReadLocalStateRequest,
  type TransactionBlueprint,
} from '@shieldedtech/capsule-blueprint';
import {
  CapsuleRuntime,
  Connector,
  ExecutableResolver,
  HttpRegistryClient,
  IndexerClient,
  SealedCapsuleStore,
  answersFromJson,
  capsuleKeysAnswers,
  isAnswersDocument,
  deriveStorageKey,
  freshMaintenanceKey,
  originGrants,
  revokeGrants,
  singleAccount,
  type AnswersDocument,
  type ConsentPort,
  type PendingTransaction,
  type RenderedArgument,
  type SettlementReport,
} from '@shieldedtech/capsule-core';
import { PortExecutor } from '@shieldedtech/capsule-executor';
import {
  IndexedDbCapabilitiesStore,
  IndexedDbCapsuleStore,
  IndexedDbGrantStore,
  capsuleViews,
  openDatabase,
} from '@shieldedtech/capsule-host-browser';
import { SdkWallet, masterSeedBytes } from '@shieldedtech/capsule-wallet-sdk-port';
import { resolveProverConfig, type NetworkConfig } from '@shieldedtech/moth-wallet/types/network';
import type {
  CapsuleAccount,
  CapsuleCall,
  CapsuleCapabilitiesDTO,
  CapsuleConsentDTO,
  CapsuleInspectorDTO,
  CapsuleRenderedArgument,
  CapsuleSiteGrantsDTO,
} from '../capsule/protocol';
import { DEMO_CAPABILITIES } from '../capsule/demo-credential';
import type { SubmissionSettled, SubmittedTx } from './submissions';
import type { HostEventData } from './worker-rpc';

type Host = typeof import('./wallet-host');

/** How the worker entry reaches the user and the background: set once, before any request. */
export interface CapsuleChannel {
  ask(consent: CapsuleConsentDTO): Promise<boolean>;
  emit(event: HostEventData['os/eventCapsule']): void;
  /** A settlement under an account, for the panels; the dApp's sessions hear of it through `emit`. */
  settled(event: HostEventData['os/eventCapsuleSettled']): void;
}
let channel: CapsuleChannel = {
  ask: () => Promise.reject(new Error('the capsule runtime has no consent channel')),
  emit: () => {},
  settled: () => {},
};
export function setCapsuleChannel(next: CapsuleChannel): void {
  channel = next;
}

const SYNC_WAIT_MS = 120_000;
const SETTLE_TIMEOUT_MS = 180_000;
/** The registry service listens beside the stack's indexer; a wallet setting of its own is plan §12. */
const REGISTRY_PORT = 8787;

let executor: PortExecutor | null = null;

/** The executor page's port, transferred from the offscreen document; a new one replaces the old and reopens every runtime. */
export function attachExecutor(port: MessagePort): void {
  executor?.close();
  executor = new PortExecutor(domEndpoint(port));
  opened.clear();
}

function requireExecutor(): PortExecutor {
  if (executor === null) throw new Error('the capsule executor is not attached: the offscreen document has not opened the sandbox page');
  return executor;
}

/** The account's installed capabilities: the document the runtime answers from, and where it is kept. */
interface Capabilities {
  store: IndexedDbCapabilitiesStore;
  /** The account's own document, or the demo's when it has none; the runtime reads it afresh for every call. */
  current: AnswersDocument;
  isDefault: boolean;
}

interface Opened {
  runtime: CapsuleRuntime;
  resolver: ExecutableResolver;
  grants: IndexedDbGrantStore;
  capabilities: Capabilities;
  connectors: Map<string, Connector>;
  /** Unsubscribers for the sessions a dApp is watching, by session id. */
  watching: Map<string, () => void>;
}

const opened = new Map<string, Promise<Opened>>();

function registryUrlFor(network: NetworkConfig): string {
  const indexer = new URL(network.indexerUrl);
  return `${indexer.protocol}//${indexer.hostname}:${REGISTRY_PORT}`;
}

function proofServerUrlFor(network: NetworkConfig): string {
  const prover = resolveProverConfig(network);
  // The runtime proves with the proof server; the in-process prover moth offers is not wired to it (plan §12).
  if (prover.type !== 'server') throw new Error(`capsule transactions need a proof server; the network '${network.id}' is set to the ${prover.type} prover`);
  return prover.url;
}

/** The runtime for an account, opened on first use over the wallet the sync engine already runs for it. */
async function open(host: Host, account: CapsuleAccount): Promise<Opened> {
  const key = `${account.network.id}/${account.walletName}`;
  let pending = opened.get(key);
  if (pending !== undefined) return pending;
  pending = (async (): Promise<Opened> => {
    const synced = await host.syncEnsure(account.seedHex, account.walletName, account.network);
    const wallet = SdkWallet.overFacade(account.seedHex, synced.facade, account.network.id);
    await wallet.waitUntilSettled(SYNC_WAIT_MS);
    const chain = new IndexerClient({ url: account.network.indexerUrl });
    const registry = new HttpRegistryClient({ url: registryUrlFor(account.network) });
    const resolver = new ExecutableResolver(registry, requireExecutor(), chain);
    // Capsules are per chain, so each network has its own database; the account id, which the
    // capsule secret is derived from, is the wallet's name as the web host's is its account name.
    const db = await openDatabase(`capsule-wallet-${account.network.id}`);
    // The storage key is derived here and the seed dropped, as the capsule keys' answers are below.
    const seedBytes = masterSeedBytes(account.seedHex);
    const store = await SealedCapsuleStore.open(new IndexedDbCapsuleStore(db), deriveStorageKey(seedBytes, account.walletName));
    // The installed capabilities are the account's document when it has one, else the demo's credential; the
    // runtime reads whichever is current at each call, and the capsule keys come last so no document can stand in for them.
    const capabilitiesStore = new IndexedDbCapabilitiesStore(db);
    const own = await capabilitiesStore.load(account.walletName);
    const capabilities: Capabilities = { store: capabilitiesStore, current: own ?? DEMO_CAPABILITIES, isDefault: own === undefined };
    const keys = capsuleKeysAnswers(seedBytes, account.walletName);
    const runtime = await CapsuleRuntime.open({
      accountId: account.walletName,
      store,
      chain,
      registry,
      resolver,
      executor: requireExecutor(),
      wallet,
      proofServerUrl: proofServerUrlFor(account.network),
      networkId: account.network.id,
      maintenanceKey: freshMaintenanceKey(),
      hostAnswers: () => ({ ...answersFromJson(capabilities.current), ...keys }),
    });
    // The wallet's activity feed: a capsule transaction is recorded as it is submitted and its
    // outcome when the runtime settles it, like a send, so the feed names the contract and the
    // circuit where history alone would show the fee (plan §12 row 36).
    runtime.onSubmission((tx) => void host.noteSubmitted(account.network.id, account.walletName, contractSubmission(tx)));
    runtime.onSettlement((report) => {
      void host.noteSettled(account.network.id, account.walletName, report.identifier, settlementOf(report));
      channel.settled({
        walletName: account.walletName,
        networkId: account.network.id,
        identifier: report.identifier,
        status: report.outcome.status,
        contracts: [...report.capsules.map((c) => c.address), ...report.deploys.map((d) => d.address)],
      });
    });
    if (runtime.account.pendingTransactions().length > 0) {
      runtime.settlePending({ timeoutMs: SETTLE_TIMEOUT_MS }).catch(() => {});
    }
    return { runtime, resolver, grants: new IndexedDbGrantStore(db), capabilities, connectors: new Map(), watching: new Map() };
  })();
  opened.set(key, pending);
  pending.catch(() => opened.delete(key));
  return pending;
}

/** A capsule transaction as the activity feed records it: the call asked for, else the first contract deployed. */
function contractSubmission(tx: PendingTransaction): SubmittedTx {
  const deploy = tx.deploys[0];
  const contract =
    tx.asked !== undefined
      ? { address: tx.asked.address, circuit: tx.asked.circuit }
      : deploy !== undefined
        ? { address: deploy.address, bundle: deploy.bundle }
        : undefined;
  return { hash: tx.identifier, submittedAt: tx.submittedAt.getTime(), kind: 'contract', ...(contract === undefined ? {} : { contract }) };
}

function settlementOf(report: SettlementReport): SubmissionSettled {
  const { outcome } = report;
  const status =
    outcome.status === 'expired' ? 'expired' : outcome.status === 'failure' ? 'failed' : outcome.status === 'partial' ? 'partial' : 'landed';
  return { status, at: outcome.block.timestamp };
}

const rendered = (argument: RenderedArgument): CapsuleRenderedArgument => ({
  rendered: argument.rendered,
  bytes: { value: [...argument.bytes.value] },
});

/** The runtime's questions, put to the user by the background's approval screens. */
const consent: ConsentPort = {
  connect: (c) =>
    channel.ask({
      kind: 'capsuleConnect',
      origin: c.origin,
      account: c.account,
      ...(c.contract === undefined ? {} : { contract: c.contract }),
      ...(c.bundle === undefined ? {} : { bundle: c.bundle }),
      ...(c.fingerprint === undefined ? {} : { fingerprint: c.fingerprint }),
    }),
  read: (c) =>
    channel.ask({ kind: 'capsuleRead', origin: c.origin, account: c.account, contract: c.contract, bundle: c.bundle, name: c.name }),
  transaction: (c) =>
    channel.ask({
      kind: 'capsuleTransaction',
      origin: c.origin,
      account: c.account,
      calls: c.calls.map((call) => ({
        contract: call.contract,
        bundle: call.bundle,
        entrypoint: call.entrypoint,
        arguments: call.arguments.map(rendered),
      })),
      reached: c.reached.map((call) => ({ contract: call.contract, bundle: call.bundle, entrypoint: call.entrypoint })),
      deploys: c.deploys.map((deploy) => ({
        bundle: deploy.bundle,
        fingerprint: deploy.fingerprint,
        address: deploy.address,
        arguments: deploy.arguments.map(rendered),
      })),
      capabilities: c.capabilities.map((capability) => ({
        contract: capability.contract,
        bundle: capability.bundle,
        interfaceId: capability.interfaceId,
        functions: [...capability.functions],
      })),
      ttl: c.ttl.toISOString(),
    }),
};

/** The connector for one attested origin under one account, made on first contact and kept. */
async function connectorFor(host: Host, call: CapsuleCall): Promise<{ connector: Connector; account: Opened }> {
  const account = await open(host, call);
  let connector = account.connectors.get(call.origin);
  if (connector === undefined) {
    connector = new Connector({
      origin: call.origin,
      accounts: singleAccount(account.runtime),
      grants: account.grants,
      consent,
      settleTimeoutMs: SETTLE_TIMEOUT_MS,
      onError: (error) => console.warn('[capsule]', error),
    });
    account.connectors.set(call.origin, connector);
  }
  return { connector, account };
}

export async function connect(host: Host, data: CapsuleCall & { request: ConnectRequest }) {
  const { connector } = await connectorFor(host, data);
  return connector.connect(data.request);
}

export async function describe(host: Host, data: CapsuleCall & { session: string; request: DescribeRequest }) {
  const { connector } = await connectorFor(host, data);
  return connector.describe(data.session, data.request);
}

export async function submitBlueprint(host: Host, data: CapsuleCall & { session: string; document: TransactionBlueprint }) {
  const { connector } = await connectorFor(host, data);
  return connector.submitBlueprint(data.session, data.document);
}

export async function makeTransaction(host: Host, data: CapsuleCall & { session: string; document: TransactionBlueprint }) {
  const { connector } = await connectorFor(host, data);
  return connector.makeBlueprintTransaction(data.session, data.document);
}

export async function estimate(host: Host, data: CapsuleCall & { session: string; document: TransactionBlueprint }) {
  const { connector } = await connectorFor(host, data);
  return connector.estimateBlueprint(data.session, data.document);
}

export async function readLocalState(host: Host, data: CapsuleCall & { session: string; request: ReadLocalStateRequest }) {
  const { connector } = await connectorFor(host, data);
  return connector.readLocalState(data.session, data.request);
}

export async function watch(host: Host, data: CapsuleCall & { session: string; watch: boolean }): Promise<void> {
  const { connector, account } = await connectorFor(host, data);
  account.watching.get(data.session)?.();
  account.watching.delete(data.session);
  if (data.watch) {
    const session = data.session;
    account.watching.set(
      session,
      connector.onCapsuleEvent(session, (event) => channel.emit({ session, event })),
    );
  }
}

export async function disconnect(host: Host, data: CapsuleCall & { session: string }): Promise<void> {
  const { connector, account } = await connectorFor(host, data);
  account.watching.get(data.session)?.();
  account.watching.delete(data.session);
  await connector.disconnect(data.session);
}

export async function grants(host: Host, data: CapsuleAccount): Promise<CapsuleSiteGrantsDTO[]> {
  const account = await open(host, data);
  return (await originGrants(account.grants, data.walletName)).map(({ origin, contracts }) => ({ origin, contracts: [...contracts] }));
}

/** The account's installed capabilities, for the settings screen. */
export async function capabilities(host: Host, data: CapsuleAccount): Promise<CapsuleCapabilitiesDTO> {
  const { capabilities } = await open(host, data);
  return { document: capabilities.current, isDefault: capabilities.isDefault };
}

/** Replaces the account's installed capabilities, or restores the demo's with `null`; the next call answers from it. */
export async function setCapabilities(host: Host, data: CapsuleAccount & { document: AnswersDocument | null }): Promise<CapsuleCapabilitiesDTO> {
  const { capabilities } = await open(host, data);
  if (data.document !== null && !isAnswersDocument(data.document)) {
    throw new Error('installed capabilities are an object of interface ids, each an object of function names to values');
  }
  if (data.document === null) {
    await capabilities.store.clear(data.walletName);
    capabilities.current = DEMO_CAPABILITIES;
    capabilities.isDefault = true;
  } else {
    await capabilities.store.save(data.walletName, data.document);
    capabilities.current = data.document;
    capabilities.isDefault = false;
  }
  return { document: capabilities.current, isDefault: capabilities.isDefault };
}

export async function revoke(host: Host, data: CapsuleAccount & { origin: string; contract?: string }): Promise<void> {
  const account = await open(host, data);
  await revokeGrants(account.grants, data.origin, data.walletName, data.contract);
}

export async function list(host: Host, data: CapsuleAccount): Promise<CapsuleInspectorDTO> {
  const account = await open(host, data);
  const setAside = account.runtime.setAside;
  return {
    capsules: await capsuleViews(account.runtime),
    pending: account.runtime.account.pendingTransactions().map((tx) => ({
      identifier: tx.identifier,
      calls: tx.calls.map((call) => ({ address: call.address, circuit: call.circuit })),
      submittedAt: tx.submittedAt.toISOString(),
      ttl: tx.ttl.toISOString(),
    })),
    ...(setAside === undefined
      ? {}
      : { setAside: { genesis: setAside.genesis, capsules: setAside.capsules, pending: setAside.pending } }),
  };
}

// The capsule runtime, inside the wallet worker beside the sync engine: one runtime per unlocked
// account on a network, over the synced wallet's own facade, with the executor behind the port the
// offscreen document transferred in, capsules and grants in this worker's IndexedDB, and one
// connector per dApp origin, which asks the user through the consent channel the worker entry
// wires to the background. Reached through host-dispatch, lazily: this module carries the ledger.

import {
  domEndpoint,
  type ConnectRequest,
  type ReadLocalStateRequest,
  type TransactionBlueprint,
} from '@shieldedtech/capsule-blueprint';
import {
  AccountBook,
  CapsuleRuntime,
  Connector,
  contractRefusal,
  ExecutableResolver,
  HttpRegistryClient,
  IndexerClient,
  SealedCapsuleStore,
  accountIdOf,
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
  type WalletPort,
} from '@shieldedtech/capsule-core';
import { PortExecutor } from '@shieldedtech/capsule-executor';
import {
  IndexedDbAccountBookStore,
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
  CapsuleAccountsDTO,
  CapsuleCall,
  CapsuleCapabilitiesDTO,
  CapsuleConsentDTO,
  CapsuleInspectorDTO,
  CapsuleRenderedArgument,
  CapsuleSiteGrantsDTO,
} from '../capsule/protocol';
import { healthTracked } from './capsule-wallet-port';
import type { SubmissionSettled, SubmittedTx } from './submissions';
import type { HostEventData } from './worker-rpc';

type Host = typeof import('./wallet-host');

/** An account with no capabilities of its own: the runtime answers only its own interface, the capsule keys. */
const NO_CAPABILITIES: AnswersDocument = {};

/** How the worker entry reaches the user and the background: set once, before any request. */
export interface CapsuleChannel {
  ask(consent: CapsuleConsentDTO): Promise<boolean>;
  emit(event: HostEventData['os/eventCapsule']): void;
  /** A settlement under an account, for the panels; the dApp's sessions hear of it through `emit`. */
  settled(event: HostEventData['os/eventCapsuleSettled']): void;
  /** A contract's refusal of a site's call, for the panels: the site is told a code, the user the reason. */
  refused(event: HostEventData['os/eventCapsuleRefused']): void;
}
let channel: CapsuleChannel = {
  ask: () => Promise.reject(new Error('the capsule runtime has no consent channel')),
  emit: () => {},
  settled: () => {},
  refused: () => {},
};
export function setCapsuleChannel(next: CapsuleChannel): void {
  channel = next;
}

const SYNC_WAIT_MS = 120_000;
/** The label a seed's first sub-account starts with; the user renames it. */
const DEFAULT_SUB_ACCOUNT_LABEL = 'Personal';
const SETTLE_TIMEOUT_MS = 180_000;

let executor: PortExecutor | null = null;

/** The executor page's port, transferred from the offscreen document; a new one replaces the old and reopens every runtime. */
export function attachExecutor(port: MessagePort): void {
  executor?.close();
  executor = new PortExecutor(domEndpoint(port));
  opened.clear();
  seeds.clear();
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

/**
 * What one top-level moth account (one seed) holds on one network: the synced wallet, the chain and
 * registry clients, its own database — the MIP's account numbers repeat from seed to seed, so no two
 * seeds share one — and the book of its sub-accounts, one of which is current.
 */
interface Seed {
  account: CapsuleAccount;
  wallet: WalletPort;
  chain: IndexerClient;
  registry: HttpRegistryClient;
  resolver: ExecutableResolver;
  db: IDBDatabase;
  seedBytes: Uint8Array;
  book: AccountBook;
}

/** One sub-account's runtime: its capsules, grants, capabilities and the connectors of the sites using it. */
interface Opened {
  seed: Seed;
  /** The sub-account's number, whose decimal string is the id in every derivation. */
  number: number;
  runtime: CapsuleRuntime;
  resolver: ExecutableResolver;
  grants: IndexedDbGrantStore;
  capabilities: Capabilities;
  connectors: Map<string, Connector>;
  /** Unsubscribers for the sessions a dApp is watching, by session id. */
  watching: Map<string, () => void>;
}

const seeds = new Map<string, Promise<Seed>>();
const opened = new Map<string, Promise<Opened>>();

/** The network names where executables come from, or it runs no capsules: nothing is guessed from the indexer's host. */
function registryUrlFor(network: NetworkConfig): string {
  if (network.registryUrl === undefined || network.registryUrl === '') {
    throw new Error(
      `the network '${network.id}' names no executable registry, so contract capsules cannot run on it; set one under Settings → Network`,
    );
  }
  return network.registryUrl;
}

function proofServerUrlFor(network: NetworkConfig): string {
  const prover = resolveProverConfig(network);
  // The runtime proves with the proof server; the in-process prover moth offers is not wired to it (plan §12).
  if (prover.type !== 'server') throw new Error(`capsule transactions need a proof server; the network '${network.id}' is set to the ${prover.type} prover`);
  return prover.url;
}

/** The seed's wallet, clients, database and account book, opened on first use; the sync engine already runs the wallet. */
async function seedOf(host: Host, account: CapsuleAccount): Promise<Seed> {
  const key = `${account.network.id}/${account.walletName}`;
  let pending = seeds.get(key);
  if (pending !== undefined) return pending;
  pending = (async (): Promise<Seed> => {
    const synced = await host.syncEnsure(account.seedHex, account.walletName, account.network);
    const sdkWallet = SdkWallet.overFacade(account.seedHex, synced.facade, account.network.id);
    await sdkWallet.waitUntilSettled(SYNC_WAIT_MS);
    const wallet = healthTracked(sdkWallet, { network: account.network, walletName: account.walletName });
    const chain = new IndexerClient({ url: account.network.indexerUrl });
    const registry = new HttpRegistryClient({ url: registryUrlFor(account.network) });
    const resolver = new ExecutableResolver(registry, requireExecutor(), chain);
    // Capsules are per chain and the account numbers inside are per seed, so the database is per (network, seed).
    const db = await openDatabase(`capsule-wallet-${account.network.id}-${account.walletName}`);
    // The storage keys and the capsule keys' answers are derived from these bytes per sub-account; the hex is kept nowhere else.
    const seedBytes = masterSeedBytes(account.seedHex);
    const book = await AccountBook.open(new IndexedDbAccountBookStore(db), DEFAULT_SUB_ACCOUNT_LABEL);
    return { account, wallet, chain, registry, resolver, db, seedBytes, book };
  })();
  seeds.set(key, pending);
  pending.catch(() => seeds.delete(key));
  return pending;
}

/** The runtime for the seed's current sub-account, opened on first use; a switch opens the other one and leaves this one be. */
async function open(host: Host, account: CapsuleAccount): Promise<Opened> {
  const seed = await seedOf(host, account);
  return openNumbered(seed, seed.book.current().number, host);
}

async function openNumbered(seed: Seed, number: number, host: Host): Promise<Opened> {
  const { account } = seed;
  const key = `${account.network.id}/${account.walletName}/${number}`;
  let pending = opened.get(key);
  if (pending !== undefined) return pending;
  pending = (async (): Promise<Opened> => {
    const id = accountIdOf(number);
    const { db, seedBytes, chain, registry, resolver, wallet } = seed;
    const store = await SealedCapsuleStore.open(new IndexedDbCapsuleStore(db), deriveStorageKey(seedBytes, id));
    // The installed capabilities are the sub-account's document when it has one, else nothing: a credential is a
    // contract's argument, handed in by the authority's own app, not an answer the wallet keeps. The runtime reads
    // whichever is current at each call, and the capsule keys come last so no document can stand in for them.
    const capabilitiesStore = new IndexedDbCapabilitiesStore(db);
    const own = await capabilitiesStore.load(id);
    const capabilities: Capabilities = { store: capabilitiesStore, current: own ?? NO_CAPABILITIES, isDefault: own === undefined };
    const keys = capsuleKeysAnswers(seedBytes, id);
    const runtime = await CapsuleRuntime.open({
      accountId: id,
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
    // circuit where history alone would show the fee (plan §12 row 36). The feed is the seed's: the money is.
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
    return { seed, number, runtime, resolver, grants: new IndexedDbGrantStore(db), capabilities, connectors: new Map(), watching: new Map() };
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

/** The sub-account as the approval screens name it: its label, never the number the derivations use. */
const labelOf = (book: AccountBook, id: string): string => book.list().find((a) => accountIdOf(a.number) === id)?.label ?? id;

/** The runtime's questions, put to the user by the background's approval screens, the account named by its label. */
const consentFor = (book: AccountBook): ConsentPort => ({
  connect: (c) =>
    channel.ask({
      kind: 'capsuleConnect',
      origin: c.origin,
      account: labelOf(book, c.account),
      ...(c.contract === undefined ? {} : { contract: c.contract }),
      ...(c.bundle === undefined ? {} : { bundle: c.bundle }),
      ...(c.fingerprint === undefined ? {} : { fingerprint: c.fingerprint }),
    }),
  read: (c) =>
    channel.ask({
      kind: 'capsuleRead',
      origin: c.origin,
      account: labelOf(book, c.account),
      contract: c.contract,
      bundle: c.bundle,
      name: c.name,
    }),
  transaction: (c) =>
    channel.ask({
      kind: 'capsuleTransaction',
      origin: c.origin,
      account: labelOf(book, c.account),
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
});

/** The connector for one attested origin under one account, made on first contact and kept. */
async function connectorFor(host: Host, call: CapsuleCall): Promise<{ connector: Connector; account: Opened }> {
  const account = await open(host, call);
  let connector = account.connectors.get(call.origin);
  if (connector === undefined) {
    connector = new Connector({
      origin: call.origin,
      accounts: singleAccount(account.runtime),
      grants: account.grants,
      consent: consentFor(account.seed.book),
      settleTimeoutMs: SETTLE_TIMEOUT_MS,
      onError: (error) => {
        console.warn('[capsule]', error);
        // The contract's own refusal is the user's to see: the site hears a code, the panel the reason.
        const message = contractRefusal(error);
        if (message !== undefined) {
          channel.refused({ walletName: call.walletName, networkId: call.network.id, origin: call.origin, message });
        }
      },
    });
    account.connectors.set(call.origin, connector);
  }
  return { connector, account };
}

export async function connect(host: Host, data: CapsuleCall & { request: ConnectRequest }) {
  const { connector } = await connectorFor(host, data);
  return connector.connect(data.request);
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
  return (await originGrants(account.grants, accountIdOf(account.number))).map(({ origin, contracts }) => ({
    origin,
    contracts: contracts.map((c) => ({ address: c.address, call: c.call, reads: [...c.reads] })),
  }));
}

/** The account's installed capabilities, for the settings screen. */
export async function capabilities(host: Host, data: CapsuleAccount): Promise<CapsuleCapabilitiesDTO> {
  const { capabilities } = await open(host, data);
  return { document: capabilities.current, isDefault: capabilities.isDefault };
}

/** Replaces the account's installed capabilities, or removes them with `null`; the next call answers from what is left. */
export async function setCapabilities(host: Host, data: CapsuleAccount & { document: AnswersDocument | null }): Promise<CapsuleCapabilitiesDTO> {
  const { capabilities, number } = await open(host, data);
  if (data.document !== null && !isAnswersDocument(data.document)) {
    throw new Error('installed capabilities are an object of interface ids, each an object of function names to values');
  }
  const id = accountIdOf(number);
  if (data.document === null) {
    await capabilities.store.clear(id);
    capabilities.current = NO_CAPABILITIES;
    capabilities.isDefault = true;
  } else {
    await capabilities.store.save(id, data.document);
    capabilities.current = data.document;
    capabilities.isDefault = false;
  }
  return { document: capabilities.current, isDefault: capabilities.isDefault };
}

/**
 * Takes a site's grants back: on one contract under the current sub-account (a row of Connected
 * sites), or the site's whole standing under every sub-account of the seed (forgetting the site).
 */
export async function revoke(host: Host, data: CapsuleAccount & { origin: string; contract?: string }): Promise<void> {
  if (data.contract !== undefined) {
    const account = await open(host, data);
    await revokeGrants(account.grants, data.origin, accountIdOf(account.number), data.contract);
    return;
  }
  const seed = await seedOf(host, data);
  const grants = new IndexedDbGrantStore(seed.db);
  for (const entry of seed.book.list()) {
    await revokeGrants(grants, data.origin, accountIdOf(entry.number));
  }
}

/** The seed's sub-accounts and which is current, for the capsule screen's selector. */
export async function accounts(host: Host, data: CapsuleAccount): Promise<CapsuleAccountsDTO> {
  const seed = await seedOf(host, data);
  return { accounts: [...seed.book.list()], current: seed.book.current().number };
}

/**
 * Changes the seed's sub-accounts: selects one (the next session any site opens runs under it; the
 * sites' sessions under the old one are left to lapse, so a site reconnects and is asked afresh),
 * creates one, or renames one — a rename moves nothing, the label being part of no key.
 */
export async function setAccounts(
  host: Host,
  data: CapsuleAccount & ({ select: number } | { create: string } | { rename: { number: number; label: string } }),
): Promise<CapsuleAccountsDTO> {
  const seed = await seedOf(host, data);
  if ('select' in data) {
    await seed.book.select(data.select);
  } else if ('create' in data) {
    await seed.book.create(data.create);
  } else {
    await seed.book.rename(data.rename.number, data.rename.label);
  }
  return { accounts: [...seed.book.list()], current: seed.book.current().number };
}

export async function list(host: Host, data: CapsuleAccount): Promise<CapsuleInspectorDTO> {
  const account = await open(host, data);
  const setAside = account.runtime.setAside;
  return {
    account: { number: account.number, label: labelOf(account.seed.book, accountIdOf(account.number)) },
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

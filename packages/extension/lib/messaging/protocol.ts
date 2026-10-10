// Typed request/response protocol between UI surfaces (side panel, approval
// window) and the background service worker. All payloads must survive
// structured cloning — bigints and Dates travel as serialized strings.

import { defineExtensionMessaging } from '@webext-core/messaging';
import type { WalletInfo, TxStage, ProverConfig } from '@shieldedtech/moth-browser';
import type { SerializedConnectorError } from '../connector/errors';
import type { PendingApproval } from '../background/approvals';
import type { OriginGrant } from '../background/permissions';
import type { AddressBookEntry } from '../background/address-book';
import type { AddressKind } from '../ui/address';
import type { TimingEntry } from '../background/timings';
import type { MeterSnapshot } from '../offscreen/request-meter';

/**
 * Registration cannot pay its own fee yet.
 *
 * Specks as decimal strings and seconds as a number, because this crosses a
 * JSON channel where a bigint would not survive. `secondsUntilAffordable` is null
 * when waiting cannot help — the holding's ceiling is below the fee, so the
 * answer is more NIGHT rather than more patience.
 */
export interface DustNotYet {
  feeSpecks: string;
  availableSpecks: string;
  secondsUntilAffordable: number | null;
}
import type { RelayState } from '../offscreen/relay-socket';

export type { RelayState };

// ---------------------------------------------------------------------------
// Balances serialization (WalletBalances is full of bigints and Dates)
// ---------------------------------------------------------------------------
// Lives in ./balances-json so the wallet worker can reuse it without pulling in
// @webext-core/messaging (which statically imports webextension-polyfill and
// throws outside extension contexts). Re-exported here so existing importers
// (lib/ui/client.ts, connector-handlers.ts, tests) need no changes.
export { serializeBalances, deserializeBalances } from './balances-json';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface SessionStatus {
  locked: boolean;
  walletName?: string;
  /** User-chosen display label for the unlocked account, if set. */
  walletLabel?: string;
  address?: string;
  /** Bech32m addresses per role for the unlocked wallet (safe to expose). */
  addresses?: WalletInfo['addresses'];
  network: string;
}

export interface CreateWalletRequest {
  name: string;
  passphrase: string;
  network?: string;
  birthday?: number;
  /** Persist this pre-generated phrase (shown to the user first) instead of a fresh one. */
  mnemonic?: string;
}

/**
 * Restore an existing account from either backup artifact. Exactly one of
 * `mnemonic` / `seed` is required, enforced by the union rather than by a
 * runtime check, so a caller cannot send both or neither.
 *
 * The seed arm exists because a wallet created from a raw hex seed has no
 * mnemonic and never will — BIP-39's phrase-to-seed step is a one-way KDF, so
 * there is nothing to type into a word grid. Before this, such an account could
 * be created in the TUI and CLI but was unreachable from the extension, even
 * though the extension's own session model is seed-based throughout.
 */
export type ImportWalletRequest = {
  name: string;
  passphrase: string;
  network?: string;
} & (
  | {mnemonic: string; seed?: never}
  | {seed: string; mnemonic?: never}
);

export interface SendTokensRequest {
  type: 'shielded' | 'unshielded';
  tokenId: string;
  /** bigint as decimal string */
  amount: string;
  to: string;
}

/**
 * An HTTP header attached to requests to the node, for endpoints that gate
 * access behind one. Preprod rate-limits and answers 403 without the operator's
 * bypass header.
 *
 * SECRET. The value is a credential: stored in `storage.local` alongside the
 * rest of settings, masked in the UI, never logged, never shown in developer
 * mode, and never included in the diagnostics export — which promises "labels,
 * durations and sizes only". It ships with an empty value; only the header
 * *name* has a default.
 *
 * Note this is NOT protected by the wallet passphrase — unlike seeds it is not
 * in the encrypted keystore, so it is readable by anything with access to the
 * browser profile.
 */
export interface NodeAuthHeader {
  /** Header name, e.g. `x-shielded-ratelimit-bypass`. */
  name: string;
  /** Header value. Empty means "no header" and the whole thing is dropped. */
  value: string;
}

export interface NetworkEndpoints {
  nodeUrl: string;
  indexerUrl: string;
  prover: ProverConfig;
  /** Optional; scoped to the node host only. The indexer is not rate-limited
   *  today, and a credential should reach as few destinations as possible. */
  nodeAuthHeader?: NodeAuthHeader;
}

export interface ExtensionSettings {
  /**
   * Network of the ACTIVE account. Each account stores its own network in its
   * wallet metadata; this field follows the account currently in use (aligned
   * on unlock) so sync, transactions and the dApp connector all resolve
   * endpoints for it. It doubles as the preselected network for new accounts.
  */
  network: string;
  /** Full endpoint overrides for `network`; null uses its maintained preset. */
  customEndpoints: NetworkEndpoints | null;
  /** Minutes of inactivity before the wallet auto-locks; null = never (demo). */
  autoLockMinutes: number | null;
  /** Base URL of the `.shielded` name-registry read API for send-to-name
   *  (e.g. `http://localhost:4000`); null disables name resolution. See
   *  docs/adr/0002. */
  nameResolverUrl: string | null;
  /**
   * Build this network's pre-seed reference in the background so accounts created
   * afterwards start at chain tip instead of walking the chain (78.6 min of dust
   * sync becomes ~49s on preprod). Off by default: the build IS that walk, ~an
   * hour of background traffic per network, and resumes across sessions until it
   * completes. Only accounts created AFTER it finishes benefit — older ones are
   * refused by the birthday guard and take the slow path.
   */
  preseedWarming: boolean;
  /**
   * Show infrastructure detail the wallet otherwise keeps to itself — endpoint
   * URLs, HTTP status codes, retry counters. Off by default: it is diagnostic
   * vocabulary, and a wallet that talks about 403s at rest teaches users to
   * ignore warnings. Never gates a warning itself, only how much it says.
   */
  developerMode: boolean;
  /**
   * Blockfrost project id. Required for anything that reads Cardano state or
   * submits a Cardano transaction; address derivation works without it.
   *
   * SECRET, on the same terms as `NodeAuthHeader.value` above: stored in
   * `storage.local`, masked in the UI, never logged, never in diagnostics — and
   * NOT protected by the wallet passphrase, so anything with access to the
   * browser profile can read it.
   */
  blockfrostProjectId: string | null;
  /**
   * Blockfrost project ids keyed by Cardano network ('Mainnet' | 'Preprod' |
   * 'Preview'). A project id is issued for one network and rejected by the
   * others — a preview key against preprod is a 403, not a fallback — so
   * switching networks must switch credentials with it.
   *
   * `blockfrostProjectId` above is the legacy single value, still honoured as
   * a fallback for a setup made before the split.
   */
  blockfrostProjectIds: Record<string, string>;
  /**
   * Overrides for a redeployed cNIGHT token or a self-hosted Blockfrost. No UI:
   * they exist so a contract redeploy does not need an extension release, and
   * the defaults are right until one happens.
   */
  blockfrostUrl: string | null;
  cnightPolicyId: string | null;
  cnightAssetName: string | null;
}

/**
 * Cardano accounts as the panel sees them. Mirrors core's
 * `CardanoAccountList` — readonly, because that is what core returns and the
 * panel has no business mutating it.
 */
export interface CardanoAccountListDTO {
  readonly accounts: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly kind: 'derived' | 'imported';
    readonly accountIndex: number;
  }>;
  readonly activeId: string;
}

/**
 * What a CIP-30 signing approval shows. Only the method name: a dApp-supplied
 * transaction is CBOR, and decoding it to display amounts is a separate piece
 * of work that must not be faked with a reassuring summary in the meantime.
 */
export interface CardanoSignApprovalPayload {
  readonly method: string;
}

/** Result of resolving a `.shielded` name to a send target (send-to-name). */
export interface NameResolution {
  /** The bare registry name that was queried. */
  name: string;
  /** `records.address` from the resolver, if the name is registered and
   *  publishes an address record; null otherwise. Not guaranteed to be a
   *  valid Midnight address — the UI must validate before offering send. */
  address: string | null;
  /** Attestation level the registry reports for the name. */
  verifiedLevel: 'verified' | 'unverified';
  /** Registry expiry epoch, when present (for staleness display). */
  expiryEpoch: number | null;
  /** Set when the name isn't registered / has no usable record / fetch failed;
   *  a human-readable, safe reason. */
  error: string | null;
}

/** Messages pushed from background to UI over the "balances" port. */
export type PortEvent =
  | { kind: 'balances'; data: string /* serializeBalances */ }
  | { kind: 'syncMessage'; message: string }
  | { kind: 'syncReset' }
  | { kind: 'txStage'; stage: TxStage }
  | { kind: 'relayState'; state: RelayState }
  | { kind: 'approval'; id: string | null }
  | { kind: 'setupOpen'; open: boolean }
  /** The session was locked out-of-band (auto-lock); the panel re-reads status. */
  | { kind: 'sessionLocked' };

export const BALANCES_PORT = 'balances';

/** Held open by the setup tab while an account is being created/imported —
 *  the panel shows a waiting screen until it closes (or setup completes). */
export const SETUP_PORT = 'setup';

// ---------------------------------------------------------------------------
// Protocol map
// ---------------------------------------------------------------------------

/** One NIGHT UTXO, reduced to what explains the balance.
 *
 *  No UTXO id, address or nonce: enough to say why registration found nothing to
 *  do, not enough to identify the coin on chain. */
export interface NightCoinRow {
  /** Value in STARS, as a string — bigint does not survive the message channel. */
  valueStars: string;
  /** Already designated for DUST generation. */
  registered: boolean;
  /** Reserved as an input by a transaction that has not settled. Booked coins
   *  count toward the displayed balance but cannot be registered, which is how a
   *  wallet shows 500 NIGHT and still reports nothing to register. */
  booked: boolean;
  /** When this UTXO arrived, epoch ms — null if unknown. Powers the "register
   *  promptly" warning: a devnet defect (docs/upstream-issues) has so far only
   *  ever been triggered by registering NIGHT that sat unregistered for
   *  minutes, never by registering within seconds of it arriving. */
  ctimeMs: number | null;
}

interface ProtocolMap {
  walletList(): WalletInfo[];
  walletCreate(data: CreateWalletRequest): { info: WalletInfo; mnemonic: string };
  walletImport(data: ImportWalletRequest): WalletInfo;
  walletRemove(data: { name: string }): void;
  walletSetActive(data: { name: string }): void;
  /** Set (or clear, with an empty string) an account's display label. The
   *  storage name never changes, so sync state and dApp grants stay valid. */
  walletRename(data: { name: string; label: string }): void;
  /** Reveal an account's backup secret after re-entering its password: the
   *  original mnemonic, or the raw hex seed for accounts imported from hex.
   *  Rejects on a wrong password. */
  walletExportPhrase(data: {
    name: string;
    passphrase: string;
    /**
     * Which artifact to reveal. `backup` (the default) is whatever this account
     * was created from. `seed` is the hex seed regardless — for a phrase-backed
     * account that is the 64-byte seed its 24 words expand to, which some
     * tooling wants and which cannot be reconstructed from the phrase by hand.
     */
    as?: 'backup' | 'seed';
  }): {
    kind: 'mnemonic' | 'seed';
    value: string;
  };
  /** Apply the named network and endpoint fields to the unlocked account.
   *  Network/indexer changes require explicit approval because they clear
   *  local sync state and begin a fresh sync. */
  networkConfigSave(data: {
    network: string;
    endpoints: NetworkEndpoints;
    resyncApproved: boolean;
  }): SessionStatus;

  sessionUnlock(data: { name: string; passphrase: string }): SessionStatus;
  sessionLock(): void;
  sessionStatus(): SessionStatus;

  /** Reset the inactivity timer — the panel sends this on open and on input. */
  activityPing(): void;

  /** Optional phase timings (debug page). Readable with no wallet and no
   *  unlocked session — the phases most worth measuring happen before a first
   *  wallet exists. Labels, durations and sizes only; never addresses or amounts. */
  debugTimings(): { enabled: boolean; entries: TimingEntry[] };
  debugTimingsSetEnabled(data: { enabled: boolean }): { enabled: boolean };
  debugTimingsClear(): void;

  /** Request counts grouped by host, with outcomes. Answers "how much traffic am
   *  I making, and what is the endpoint returning" — the evidence a rate-limit
   *  conversation needs.
   *
   *  Always answers, including while the offscreen document is down. The live
   *  meter dies with that document (every lock closes it), so the background
   *  retains its figures and reports them with the window zeroed rather than
   *  reporting nothing — see background/retained-request-stats.ts. */
  debugRequestStats(): MeterSnapshot;

  /** Per-coin NIGHT breakdown, for telling "booked" apart from "already
   *  registered" when registration reports nothing to do. */
  dustNightCoins(): NightCoinRow[];

  /** Clear the node-relay backoff so the next dial reaches the wire at once,
   *  instead of waiting out the current window ("Retry now"). */
  relayRetry(): RelayState | null;

  /** Latest cached balances (serialized), or null if none yet. */
  balancesSnapshot(): string | null;

  /** Bring the open setup tab to the front (no-op if none). */
  setupTabFocus(): void;
  /** Cancel setup: close any open setup tabs (no-op if none). */
  setupTabClose(): void;

  /** Build, prove and submit a transfer of one or more outputs (possibly
   *  different tokens/recipients) as a single transaction. Stage updates stream
   *  over the port. */
  sendTokens(data: { outputs: SendTokensRequest[] }): { txHash: string };

  /** Complete estimated fee in raw SPECK for the whole batch, as a decimal string. */
  estimateTransferFee(data: { outputs: SendTokensRequest[] }): { fee: string };

  /** Register the wallet's unshielded NIGHT for DUST generation. Stage updates
   *  stream over the port. `txHash` is null when nothing needed registering.
   *  `dustAddress` optionally directs the generated DUST to another wallet's
   *  DUST address (defaults to this wallet's own). */
  registerDust(data: { dustAddress?: string } | undefined): {
    txHash: string | null;
    /** Set when registration cannot pay its own fee yet — see
     *  core sync/dust-registration-estimate.ts. Not an error: nothing was built,
     *  booked or spent, and the same call succeeds later untouched. Specks are
     *  strings because this channel is JSON. */
    notYet?: DustNotYet;
  };

  /** Deregister all registered NIGHT from DUST generation. Stage updates
   *  stream over the port. */
  deregisterDust(): { txHash: string };

  /** Forget everything synced for the unlocked account on its network — sync
   *  state, cached balances, pending activity, and the network's prepared
   *  reference — and sync again from the start of the chain. For a local
   *  network that was brought back up from genesis, where the cached state
   *  describes a chain that no longer exists. Spends nothing. */
  resyncFromScratch(): void;

  /** Rebuild the local DUST view: evict the dust sync cache and rescan. Spends
   *  nothing. `started` is false when a transaction was in flight. */

  /** Build this network's pre-seed reference to chain tip so accounts created
   *  afterwards skip the chain walk (78.6 min of dust sync becomes ~49s on
   *  preprod). Runs for tens of minutes, resumes if interrupted, and spends
   *  nothing. `started` is false when a build was already running. */
  preseedWarm(): { started: boolean };

  /** Readiness of this network's pre-seed reference, plus live build progress. */
  preseedStatus(): {
    ready: boolean;
    height: number | null;
    /** This release ships a reference for the current network, so building one
     *  on the device is not offered — see components/screens/Settings.tsx. */
    bundled: boolean;
    building: boolean;
    applied: number;
    total: number;
  };
  dustRebuild(): { started: boolean };

  // -------------------------------------------------------------------------
  // Cardano / cNIGHT
  //
  // Every verb needs the unlocked session's mnemonic, so all of them reject
  // while locked. `cardanoAddresses` is the only one that works without a
  // Blockfrost project id — derivation is pure.
  // -------------------------------------------------------------------------

  /**
   * Cardano accounts for the unlocked wallet, and which one is active.
   *
   * `derived` accounts are CIP-1852 indices of the wallet's own recovery
   * phrase; `imported` ones carry a separate phrase and are Cardano-only.
   */
  cardanoAccountList(): CardanoAccountListDTO;
  /** Add the next CIP-1852 index of the wallet's own phrase, and select it. */
  cardanoAccountAdd(data: { label?: string } | undefined): CardanoAccountListDTO;
  /**
   * Import a Cardano-only account from a separate recovery phrase. Requires the
   * wallet passphrase, which encrypts the imported phrase at rest.
   */
  cardanoAccountImport(data: { mnemonic: string; passphrase: string; label?: string }): CardanoAccountListDTO;
  cardanoAccountSelect(data: { id: string }): CardanoAccountListDTO;
  /** Removing an imported account destroys moth's only copy of its phrase. */
  cardanoAccountRemove(data: { id: string }): CardanoAccountListDTO;
  cardanoAccountRename(data: { id: string; label: string }): CardanoAccountListDTO;

  /**
   * Midnight accounts offerable as DUST receivers, each with the coin public
   * key a registration needs. Derived from public addresses, so locked
   * accounts are included.
   */
  cardanoReceiverAccounts(): Array<{
    name: string;
    label: string;
    shieldedAddress: string;
    /** bech32m, for display. */
    dustAddress: string;
    /** Serialized DUST address — what a registration datum records. */
    dustAddressBytes: string;
  }>;

  /**
   * Resolve a pasted `mn_dust_…` address or its 66-hex serialization into the
   * bytes a registration records. Rejects a shielded address by name — it is
   * the obvious thing to paste and the wrong value.
   */
  cardanoResolveReceiver(data: { input: string }): { dustAddressBytes: string };

  /** Derived Cardano addresses for the unlocked account. No network access. */
  cardanoAddresses(): {
    cardanoNetwork: string;
    address: string;
    rewardAddress: string;
    stakeKeyHash: string;
    paymentKeyHash: string;
  };

  /** cNIGHT holdings plus both sides of the DUST designation picture. */
  cardanoStatus(): {
    cardanoNetwork: string;
    address: string;
    rewardAddress: string;
    /** Decimal strings — both exceed Number's safe integer range. */
    lovelace: string;
    cnight: string;
    cnightUtxos: number;
    registered: boolean;
    registeredDustAddress: string | null;
    /** True when the registration points at THIS account's DUST address. */
    registeredToThisWallet: boolean;
    registrationUtxo: string | null;
    /** Midnight-side rate; null until the indexer has observed the registration. */
    generationRate: string | null;
    /** Accrued DUST and its ceiling, in SPECK (10^15 per DUST). */
    currentCapacity: string | null;
    maxCapacity: string | null;
    /**
     * Midnight waits for Cardano finality (k=2160 blocks, ~12 hours) before
     * acting on a registration. These carry that wait so the panel can count
     * down instead of saying "soon". Null when there is nothing to wait for or
     * the registration transaction is not yet in a block.
     */
    generatingFrom: number | null;
    secondsRemaining: number | null;
    /**
     * What Midnight made of the registration. null = no record (not yet seen,
     * or finality has not passed); false = ingested and REJECTED, which waiting
     * will not fix; true = generating.
     */
    midnightValid: boolean | null;
    /** More than one registration on a stake key forces deregistration. */
    registrationCount: number;
    /**
     * The registration records something that is not a 33-byte DUST address,
     * so it can never generate DUST. `update` rewrites it in one transaction.
     */
    legacyDustAddress: boolean;
  };

  /** `dustAddress` omitted means this account's own. */
  cardanoRegister(data: { dustAddress?: string } | undefined): { txHash: string; explorer: string };
  cardanoDeregister(): { txHash: string; explorer: string; cleared: number };
  cardanoUpdate(data: { dustAddress: string }): { txHash: string; explorer: string };

  /**
   * Send ADA and/or cNIGHT from the active Cardano account.
   *
   * Amounts are decimal strings: lovelace and token counts both exceed
   * Number's safe integer range, and this channel is JSON.
   */
  cardanoSend(data: { to: string; lovelace: string; cnight: string }): { txHash: string; explorer: string };

  /** Activity feed (on-chain history + pending local submissions), newest
   *  first, serialized with serializeActivity (entries carry bigints). */
  activityGet(): string;

  settingsGet(): ExtensionSettings;
  settingsSet(data: Partial<ExtensionSettings>): ExtensionSettings;

  /** Forward-resolve a `.shielded` registry name to a send target via the
   *  configured name-resolver read API. Fetched in the background (host
   *  permissions apply there). Never throws for a normal miss — returns a
   *  NameResolution with `error` set. */
  resolveName(data: { name: string }): NameResolution;

  /** User-assigned token display names, keyed by full token id. */
  tokenNamesGet(): Record<string, string>;
  /** Set (or clear, with an empty string) a token's display name; returns the
   *  updated map. */
  tokenNameSet(data: { tokenId: string; name: string }): Record<string, string>;

  /** The saved address book (named shielded/unshielded/DUST addresses). */
  addressBookGet(): AddressBookEntry[];
  /** Insert (no id) or update (with id) an entry; returns the updated list. */
  addressBookSave(data: { id?: string; name: string; address: string; kind: AddressKind }): AddressBookEntry[];
  /** Remove an entry by id; returns the updated list. */
  addressBookRemove(data: { id: string }): AddressBookEntry[];

  /** dApp connector call relayed by the content script (bigint-JSON payloads). */
  connectorRequest(data: { method: string; paramsJson: string }):
    | { ok: true; resultJson: string }
    | { ok: false; error: SerializedConnectorError };

  approvalGet(data: { id: string }): { approval: PendingApproval | null; locked: boolean };
  approvalResolve(data: { id: string; approved: boolean }): void;
  /** The approval currently awaiting a decision, if any (panel checks on mount). */
  approvalPending(): { approval: PendingApproval | null; locked: boolean };

  /** Resolved endpoints for the active network (read-only, for Settings). */
  networkConfigGet(): { id: string; nodeUrl: string; indexerUrl: string; prover: ProverConfig };

  permissionsList(): Record<string, OriginGrant>;
  permissionsRevoke(data: { origin: string }): void;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();

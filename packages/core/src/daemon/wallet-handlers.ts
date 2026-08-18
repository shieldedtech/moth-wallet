// Shared RPC handler factory for the wallet daemon. Both the TUI host
// (packages/tui/src/hooks/useDaemonHost.ts) and the headless host
// (packages/cli/src/commands/daemon/serve.ts) call this with the same
// dependency bundle and get the same Record<string, RpcHandler> back.
//
// Until this file existed, each host had its own copy of every
// handler body. Each new verb meant editing two files in lockstep.
// This factory takes the verb count from O(2N) edits down to O(N).

import {resolve as resolvePath} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Buffer} from 'node:buffer';
import type * as ledger from '@midnight-ntwrk/ledger-v8';
import {ledger as activeLedger} from '../ledger/index.js';
import type {WalletFacade} from '@midnightntwrk/wallet-sdk/facade';

import {DaemonProtocolError} from './protocol.js';
import type {ConfirmationQueue} from './confirmation-queue.js';
import type {RpcHandler, ConnectionContext} from './server.js';
import type {AuditLog, AuditDecision} from './audit-log.js';
import {
  parseSubmitTransactionParams,
  parseTransferTokensParams,
  parseCallCircuitParams,
  parseDeployContractParams,
  parseDustRegisterParams,
  parseDustDeregisterParams,
  parseInsertVerifierKeyParams,
  parseInsertVerifierKeysBatchParams,
  shortenAddress,
  shortenHex,
} from './wallet-rpc-parsers.js';
import type {
  DaemonCallCircuitResult,
  DaemonDeployContractResult,
  DaemonDustDeregisterResult,
  DaemonDustRegisterResult,
  DaemonGetStateResult,
  DaemonInsertVerifierKeyResult,
  DaemonInsertVerifierKeysBatchResult,
  DaemonSubmitTransactionResult,
  DaemonTransferTokensResult,
} from './wallet-rpc-types.js';

import {sendTokensWithKeys, designateForDustWithKeys, dedesignateFromDustWithKeys} from '../sync/operations.js';
import type {WalletKeys} from '../sync/operations.js';
import {callCircuit} from '../contract/call.js';
import {deployContract} from '../contract/deploy.js';
import {insertVerifierKey, insertVerifierKeys} from '../contract/maintenance.js';
import {loadContractArtifact} from '../contract/artifact-loader.js';
import {parseArgs, toPositionalArgs} from '../contract/args-parser.js';
import {resolveInitialPrivateState} from '../contract/initial-private-state.js';
import {clearSyncCache} from '../sync/wallet-sync.js';
import {NIGHT_DENOMINATION, formatBalance} from '../wallet/balance-format.js';
import type {SyncedWallet, WalletBalances} from '../sync/wallet-sync.js';
import type {NetworkConfig} from '../types/network.js';
import type {TransactionResult} from '../types/transaction.js';
import type {DerivedKeys} from '../types/wallet.js';

const NIGHT_TOKEN_ID = '0'.repeat(64);

// callCircuit / deployContract / insertVerifierKey all take a
// CallOptions-style `keys: DerivedKeys` field that is unused at
// runtime; we pass an empty stand-in so we don't have to keep the
// BIP-39 seed available. The actual key material flows via
// walletKeys. See docs/spec/wallet-service/05-key-management.md
// D-KM-3.
const DUMMY_DERIVED_KEYS: DerivedKeys = {
  nightExternal: new Uint8Array(),
  nightInternal: new Uint8Array(),
  dust: new Uint8Array(),
  zswap: new Uint8Array(),
  metadata: new Uint8Array(),
};

export interface WalletHandlerDeps {
  /** Identifier echoed in modal payloads. */
  readonly walletName: string;
  /** Network config — also identifies which socket-bound wallet this is. */
  readonly network: NetworkConfig;
  /** Returns the live WalletFacade or null when not yet ready. */
  readonly getFacade: () => WalletFacade | null;
  /** Returns the typed key bundle or null when not yet ready. */
  readonly getWalletKeys: () => WalletKeys | null;
  /** Returns the latest WalletBalances snapshot or null. */
  readonly getBalances: () => WalletBalances | null;
  /** Queue used to surface L3 confirmation prompts. */
  readonly queue: ConfirmationQueue;
  /** Logger forwarded to long-running operation progress callbacks. */
  readonly log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Optional persistent audit sink. Every write verb's
   *  request/decision/outcome is appended to it when present;
   *  omitted handlers run with stderr-only logging (stage 1). */
  readonly auditLog?: AuditLog;
  /** Per-transaction NIGHT spend cap (raw base units). When set (headless
   *  auto-approve mode), a NIGHT transfer above this is refused. Undefined
   *  in interactive hosts, where a human approves each transfer instead. */
  readonly maxSpendRaw?: bigint;
}

/**
 * Build the wallet daemon's RPC handler map. Same map for both hosting
 * sites; differences are entirely in the deps object.
 */
export function buildWalletHandlers(deps: WalletHandlerDeps): Record<string, RpcHandler> {
  const {walletName, network, getFacade, getWalletKeys, getBalances, queue} = deps;
  const log = deps.log ?? (() => {});
  const auditLog = deps.auditLog;

  /** Resolve facade + walletKeys or throw INTERNAL_ERROR. */
  const requireReady = (): {facade: WalletFacade; walletKeys: WalletKeys} => {
    const facade = getFacade();
    const walletKeys = getWalletKeys();
    if (!facade || !walletKeys) {
      throw new DaemonProtocolError(
        'INTERNAL_ERROR',
        'wallet facade not ready — host is still initializing',
      );
    }
    return {facade, walletKeys};
  };

  /** Wrap a section that may throw into an INTERNAL_ERROR with a
   *  verb-prefixed message. DaemonProtocolError throws are re-thrown
   *  unchanged so handler-side INVALID_PARAMS / UNAUTHORIZED reach
   *  the wire intact. */
  const wrap = async <R>(verb: string, fn: () => Promise<R>): Promise<R> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DaemonProtocolError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new DaemonProtocolError('INTERNAL_ERROR', `${verb} failed: ${msg}`);
    }
  };

  /**
   * Single helper that fuses the L3 confirmation step, the wrap()
   * error mapping, and the audit-log emission for every write verb.
   *
   * - Asks the queue for approval; logs `user-denied` and throws
   *   UNAUTHORIZED if the user said no.
   * - Tags the decision as `auto-approve` or `user-approve` based on
   *   the queue's mode so the audit captures whether a human or the
   *   arming flag let it through.
   * - Runs `fn`, then records the resolved outcome — either the
   *   result (with optional `extract` for cherry-picking txHash /
   *   contractAddress / status) or the error.
   * - Re-throws DaemonProtocolError unchanged; wraps anything else
   *   as INTERNAL_ERROR (matching the old `wrap` behavior).
   *
   * Each handler thus becomes a single call:
   *
   *   return withAudit(verb, summary, details, async () => {...}, extract);
   *
   * The audit log is optional. When `deps.auditLog` is omitted (e.g.
   * in unit tests), every record() call is a no-op and the surface
   * behaviour is exactly the pre-audit code path.
   */
  const withAudit = async <R>(
    verb: string,
    summary: string,
    details: readonly string[],
    ctx: ConnectionContext | undefined,
    fn: () => Promise<R>,
    extract?: (r: R) => {txHash?: string; contractAddress?: string; status?: string},
  ): Promise<R> => {
    // Captures the connection's transport + apiKeyId once at the
    // start of the call so the audit entry survives ctx mutations
    // (e.g. if a sibling auth call landed mid-op, which shouldn't
    // happen with the per-conn lock but is cheap insurance).
    const connTags = ctx
      ? {transport: ctx.remote, apiKeyId: ctx.apiKeyId, connId: ctx.id}
      : {};

    const approved = await queue.request(summary, details);
    if (!approved) {
      auditLog?.recordRpc({
        wallet: walletName,
        network: network.id,
        verb,
        summary,
        details,
        decision: 'user-denied',
        ...connTags,
      });
      throw new DaemonProtocolError('UNAUTHORIZED', `user denied ${verb}`);
    }
    const decision: AuditDecision = queue.isAutoApprove ? 'auto-approve' : 'user-approve';
    try {
      const result = await fn();
      const extracted = extract?.(result) ?? {};
      auditLog?.recordRpc({
        wallet: walletName,
        network: network.id,
        verb,
        summary,
        details,
        decision,
        ...extracted,
        ...connTags,
      });
      return result;
    } catch (err) {
      const isDaemonErr = err instanceof DaemonProtocolError;
      const code = isDaemonErr ? (err as DaemonProtocolError).code : 'INTERNAL_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      auditLog?.recordRpc({
        wallet: walletName,
        network: network.id,
        verb,
        summary,
        details,
        decision,
        error: {code, message},
        ...connTags,
      });
      if (isDaemonErr) throw err;
      throw new DaemonProtocolError('INTERNAL_ERROR', `${verb} failed: ${message}`);
    }
  };

  const handlers: Record<string, RpcHandler> = {
    // ─────────────────────────────────────────────────────────────────
    // getState
    // ─────────────────────────────────────────────────────────────────

    getState: (): DaemonGetStateResult => {
      const b = getBalances();
      const f = getFacade();
      if (!b || !f) return {ready: false};
      return {
        ready: true,
        walletName,
        networkId: network.id,
        synced: b.synced,
        syncProgress: b.syncProgress,
        balances: {
          shielded: serializeBigintRecord(b.shielded),
          unshielded: serializeBigintRecord(b.unshielded),
          dust: b.dust.toString(),
        },
      };
    },

    // ─────────────────────────────────────────────────────────────────
    // clearSyncCache
    // ─────────────────────────────────────────────────────────────────

    clearSyncCache: async (_params: unknown, ctx: ConnectionContext) => {
      return withAudit(
        'clearSyncCache',
        `Clear sync cache for ${walletName} on ${network.id}?`,
        [
          'Removes the local serialized wallet state.',
          'Next sync will start from genesis (slow).',
        ],
        ctx,
        async () => {
          clearSyncCache(walletName, network.id);
          return {cleared: true};
        },
      );
    },

    // ─────────────────────────────────────────────────────────────────
    // submitTransaction
    // ─────────────────────────────────────────────────────────────────

    submitTransaction: async (rawParams: unknown, ctx: ConnectionContext): Promise<DaemonSubmitTransactionResult> => {
      const params = parseSubmitTransactionParams(rawParams);
      const {facade} = requireReady();
      return withAudit(
        'submitTransaction',
        params.summary ?? 'Submit a pre-built transaction',
        [
          `Wallet: ${walletName}`,
          `Network: ${network.id}`,
          `Tx size: ${Math.floor(params.hex.length / 2)} bytes`,
          ...(params.details ?? []),
        ],
        ctx,
        async () => {
          let tx: ledger.FinalizedTransaction;
          try {
            tx = activeLedger().Transaction.deserialize(
              'signature' as never,
              'proof' as never,
              'binding' as never,
              Buffer.from(params.hex, 'hex'),
            ) as ledger.FinalizedTransaction;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new DaemonProtocolError('INVALID_PARAMS', `failed to deserialize hex as FinalizedTransaction: ${msg}`);
          }
          const txId = await facade.submitTransaction(tx);
          return {txId: String(txId)};
        },
        (r) => ({txHash: r.txId}),
      );
    },

    // ─────────────────────────────────────────────────────────────────
    // transferTokens
    // ─────────────────────────────────────────────────────────────────

    transferTokens: async (rawParams: unknown, ctx: ConnectionContext): Promise<DaemonTransferTokensResult> => {
      const params = parseTransferTokensParams(rawParams);
      const {facade, walletKeys} = requireReady();

      const amountBig = BigInt(params.amount);
      const amountLabel =
        params.tokenId === NIGHT_TOKEN_ID
          ? `${formatBalance(amountBig, NIGHT_DENOMINATION)} NIGHT`
          : `${params.amount} raw (token ${shortenHex(params.tokenId)})`;
      const toLabel = shortenAddress(params.to);

      return withAudit(
        'transferTokens',
        params.summary ?? `Send ${amountLabel} to ${toLabel}`,
        [
          `Wallet: ${walletName}`,
          `Network: ${network.id}`,
          `Type: ${params.type}`,
          `Token: ${params.tokenId === NIGHT_TOKEN_ID ? 'NIGHT' : params.tokenId}`,
          `Recipient: ${params.to}`,
          `Amount: ${amountLabel}`,
          ...(deps.maxSpendRaw !== undefined
            ? [`Spend cap: ${formatBalance(deps.maxSpendRaw, NIGHT_DENOMINATION)} NIGHT per transfer`]
            : []),
          ...(params.details ?? []),
        ],
        ctx,
        async () => {
          // Headless spend cap: with no human to approve, a NIGHT transfer
          // above the operator-set --max-spend is refused. Recorded as a
          // failed decision in the audit log via withAudit's catch.
          if (
            deps.maxSpendRaw !== undefined &&
            params.tokenId === NIGHT_TOKEN_ID &&
            amountBig > deps.maxSpendRaw
          ) {
            throw new DaemonProtocolError(
              'UNAUTHORIZED',
              `transfer of ${amountLabel} exceeds the --max-spend cap of ${formatBalance(deps.maxSpendRaw, NIGHT_DENOMINATION)} NIGHT`,
            );
          }
          const txId = await sendTokensWithKeys(
            facade,
            walletKeys,
            network.id,
            [{
              type: params.type,
              tokenId: params.tokenId,
              amount: amountBig,
              to: params.to,
            }],
            (stage) => log('info', `[transferTokens] ${stage}`),
          );
          return {txId: String(txId)};
        },
        (r) => ({txHash: r.txId}),
      );
    },

    // ─────────────────────────────────────────────────────────────────
    // callCircuit
    // ─────────────────────────────────────────────────────────────────

    callCircuit: async (rawParams: unknown, ctx: ConnectionContext): Promise<DaemonCallCircuitResult> => {
      const params = parseCallCircuitParams(rawParams);
      const {facade, walletKeys} = requireReady();

      const artifactAbs = resolvePath(params.artifactPath);
      const witnessesAbs = params.witnessesPath ? resolvePath(params.witnessesPath) : undefined;

      let artifact: Awaited<ReturnType<typeof loadContractArtifact>>;
      try {
        artifact = await loadContractArtifact(artifactAbs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DaemonProtocolError('INVALID_PARAMS', `failed to load artifact at ${artifactAbs}: ${msg}`);
      }
      if (!artifact.circuits.includes(params.circuitName)) {
        throw new DaemonProtocolError(
          'INVALID_PARAMS',
          `artifact has no circuit named "${params.circuitName}". Available: ${artifact.circuits.join(', ')}`,
        );
      }

      const circuitArgs = params.args ? await parseArgs(params.args) : {};

      return withAudit(
        'callCircuit',
        params.summary ?? `Call ${params.circuitName} on ${shortenAddress(params.contractAddress)}`,
        [
          `Wallet: ${walletName}`,
          `Network: ${network.id}`,
          `Contract: ${params.contractAddress}`,
          `Circuit: ${params.circuitName}`,
          `Artifact: ${artifact.path}`,
          witnessesAbs ? `Witnesses: ${witnessesAbs}` : 'Witnesses: (none)',
          `Args: ${params.args ?? '(none)'}`,
          ...(params.details ?? []),
        ],
        ctx,
        async () => {
          // Witness provider lives on the daemon-host filesystem;
          // import here so we can include it in the CallOptions below.
          let witnesses: unknown;
          if (witnessesAbs) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const mod = (await import(pathToFileURL(witnessesAbs).href)) as any;
              witnesses = mod.default ?? mod;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new DaemonProtocolError('INTERNAL_ERROR', `failed to import witnesses module at ${witnessesAbs}: ${msg}`);
            }
          }
          const syncedWalletShim = {facade} as unknown as SyncedWallet;
          const result: TransactionResult = await callCircuit({
            contractAddress: params.contractAddress,
            circuitName: params.circuitName,
            args: circuitArgs,
            keys: DUMMY_DERIVED_KEYS,
            walletKeys,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            witnesses: witnesses as any,
            network,
            artifactPath: artifact.path,
            syncedWallet: syncedWalletShim,
            projectDir: params.projectDir ? resolvePath(params.projectDir) : undefined,
            timeoutMs: params.timeoutSec ? params.timeoutSec * 1000 : 120_000,
          });
          return flattenTxResult(result);
        },
        (r) => ({
          txHash: r.txHash,
          contractAddress: r.contractAddress ?? undefined,
          status: r.status,
        }),
      );
    },

    // ─────────────────────────────────────────────────────────────────
    // deployContract
    // ─────────────────────────────────────────────────────────────────

    deployContract: async (rawParams: unknown, ctx: ConnectionContext): Promise<DaemonDeployContractResult> => {
      const params = parseDeployContractParams(rawParams);
      const {facade, walletKeys} = requireReady();

      const artifactAbs = resolvePath(params.artifactPath);
      const witnessesAbs = params.witnessesPath ? resolvePath(params.witnessesPath) : undefined;

      let artifact: Awaited<ReturnType<typeof loadContractArtifact>>;
      try {
        artifact = await loadContractArtifact(artifactAbs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DaemonProtocolError('INVALID_PARAMS', `failed to load artifact at ${artifactAbs}: ${msg}`);
      }

      return withAudit(
        'deployContract',
        params.summary ?? `Deploy contract from ${shortenAddress(artifact.path)}`,
        [
          `Wallet: ${walletName}`,
          `Network: ${network.id}`,
          `Artifact: ${artifact.path}`,
          `Circuits: ${artifact.circuits.length} (${artifact.circuits.slice(0, 5).join(', ')}${artifact.circuits.length > 5 ? ', …' : ''})`,
          witnessesAbs ? `Witnesses: ${witnessesAbs}` : 'Witnesses: (none)',
          `Constructor args: ${params.args ?? '(none)'}`,
          ...(params.details ?? []),
        ],
        ctx,
        async () => {
          // Forward constructor args + initial private state, mirroring the
          // in-process `moth deploy` path (same JSON conventions via parseArgs).
          const constructorArgs = toPositionalArgs(params.args ? await parseArgs(params.args) : undefined);
          const initialPrivateState = await resolveInitialPrivateState(
            params.privateState,
            witnessesAbs,
            {onVerbose: (m) => log('info', `[deployContract] ${m}`)},
          );
          const syncedWalletShim = {facade} as unknown as SyncedWallet;
          const result: TransactionResult = await deployContract({
            artifact,
            walletKeys,
            network,
            syncedWallet: syncedWalletShim,
            witnessPath: witnessesAbs,
            projectDir: params.projectDir ? resolvePath(params.projectDir) : undefined,
            timeoutMs: params.timeoutSec ? params.timeoutSec * 1000 : 120_000,
            args: constructorArgs,
            initialPrivateState,
            onProgress: (stage) => log('info', `[deployContract] ${stage}`),
          });
          return flattenTxResult(result);
        },
        (r) => ({
          txHash: r.txHash,
          contractAddress: r.contractAddress ?? undefined,
          status: r.status,
        }),
      );
    },

    // ─────────────────────────────────────────────────────────────────
    // dustRegister / dustDeregister
    // ─────────────────────────────────────────────────────────────────

    dustRegister: async (rawParams: unknown, ctx: ConnectionContext): Promise<DaemonDustRegisterResult> => {
      const params = parseDustRegisterParams(rawParams);
      const {facade, walletKeys} = requireReady();
      return withAudit(
        'dustRegister',
        params.summary ?? 'Register NIGHT UTXOs for DUST generation',
        [
          `Wallet: ${walletName}`,
          `Network: ${network.id}`,
          params.receiver ? `Dust receiver: ${params.receiver}` : 'Dust receiver: (this wallet)',
          'Scope: every currently-unregistered NIGHT UTXO',
          ...(params.details ?? []),
        ],
        ctx,
        async () => {
          const txId = await designateForDustWithKeys(
            facade,
            walletKeys,
            network.id,
            params.receiver,
            (stage) => log('info', `[dustRegister] ${stage}`),
          );
          return {txId, registered: txId !== null};
        },
        (r) => ({txHash: r.txId ?? undefined}),
      );
    },

    dustDeregister: async (rawParams: unknown, ctx: ConnectionContext): Promise<DaemonDustDeregisterResult> => {
      const params = parseDustDeregisterParams(rawParams);
      const {facade, walletKeys} = requireReady();
      return withAudit(
        'dustDeregister',
        params.summary ?? 'Deregister NIGHT UTXOs from DUST generation',
        [
          `Wallet: ${walletName}`,
          `Network: ${network.id}`,
          'Scope: every currently-registered NIGHT UTXO',
          'Effect: DUST will stop generating from these UTXOs.',
          ...(params.details ?? []),
        ],
        ctx,
        async () => {
          try {
            const txId = await dedesignateFromDustWithKeys(
              facade,
              walletKeys,
              network.id,
              (stage) => log('info', `[dustDeregister] ${stage}`),
            );
            return {txId};
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Map the core's plain-Error "nothing to deregister"
            // condition onto INVALID_PARAMS so the CLI renders
            // INVALID_INPUT.
            if (msg.includes('No registered NIGHT UTXOs')) {
              throw new DaemonProtocolError('INVALID_PARAMS', msg);
            }
            // Anything else: let withAudit's catch wrap it as
            // INTERNAL_ERROR (same shape as the old wrap() path).
            throw err;
          }
        },
        (r) => ({txHash: r.txId}),
      );
    },

    // ─────────────────────────────────────────────────────────────────
    // insertVerifierKey / insertVerifierKeysBatch
    // ─────────────────────────────────────────────────────────────────

    insertVerifierKey: async (rawParams: unknown, ctx: ConnectionContext): Promise<DaemonInsertVerifierKeyResult> => {
      const params = parseInsertVerifierKeyParams(rawParams);
      const {facade, walletKeys} = requireReady();

      const artifactAbs = resolvePath(params.artifactPath);
      const vkAbs = resolvePath(params.verifierKeyPath);

      let artifact: Awaited<ReturnType<typeof loadContractArtifact>>;
      try {
        artifact = await loadContractArtifact(artifactAbs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DaemonProtocolError('INVALID_PARAMS', `failed to load artifact at ${artifactAbs}: ${msg}`);
      }
      if (!artifact.circuits.includes(params.circuitId)) {
        throw new DaemonProtocolError(
          'INVALID_PARAMS',
          `artifact has no circuit named "${params.circuitId}". Available: ${artifact.circuits.join(', ')}`,
        );
      }

      return withAudit(
        'insertVerifierKey',
        params.summary ?? `Insert verifier key for ${params.circuitId} on ${shortenAddress(params.contractAddress)}`,
        [
          `Wallet: ${walletName}`,
          `Network: ${network.id}`,
          `Contract: ${params.contractAddress}`,
          `Circuit: ${params.circuitId}`,
          `Artifact: ${artifact.path}`,
          `VK file: ${vkAbs}`,
          ...(params.details ?? []),
        ],
        ctx,
        async () => {
          const syncedWalletShim = {facade} as unknown as SyncedWallet;
          const result: TransactionResult = await insertVerifierKey({
            contractAddress: params.contractAddress,
            circuitId: params.circuitId,
            verifierKeyPath: vkAbs,
            keys: DUMMY_DERIVED_KEYS,
            walletKeys,
            network,
            artifactPath: artifact.path,
            syncedWallet: syncedWalletShim,
            projectDir: params.projectDir ? resolvePath(params.projectDir) : undefined,
            timeoutMs: params.timeoutSec ? params.timeoutSec * 1000 : 120_000,
          });
          return flattenTxResult(result);
        },
        (r) => ({txHash: r.txHash, status: r.status}),
      );
    },

    insertVerifierKeysBatch: async (rawParams: unknown, ctx: ConnectionContext): Promise<DaemonInsertVerifierKeysBatchResult> => {
      const params = parseInsertVerifierKeysBatchParams(rawParams);
      const {facade, walletKeys} = requireReady();

      const artifactAbs = resolvePath(params.artifactPath);
      let artifact: Awaited<ReturnType<typeof loadContractArtifact>>;
      try {
        artifact = await loadContractArtifact(artifactAbs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new DaemonProtocolError('INVALID_PARAMS', `failed to load artifact at ${artifactAbs}: ${msg}`);
      }
      for (const e of params.entries) {
        if (!artifact.circuits.includes(e.circuitId)) {
          throw new DaemonProtocolError(
            'INVALID_PARAMS',
            `artifact has no circuit named "${e.circuitId}". Available: ${artifact.circuits.join(', ')}`,
          );
        }
      }

      return withAudit(
        'insertVerifierKeysBatch',
        params.summary ?? `Batch-insert ${params.entries.length} verifier key${params.entries.length === 1 ? '' : 's'} on ${shortenAddress(params.contractAddress)}`,
        [
          `Wallet: ${walletName}`,
          `Network: ${network.id}`,
          `Contract: ${params.contractAddress}`,
          `Artifact: ${artifact.path}`,
          `Circuits: ${params.entries.map((e) => e.circuitId).join(', ')}`,
          params.skipExisting ? 'Mode: skip-already-defined' : 'Mode: insert all',
          ...(params.details ?? []),
        ],
        ctx,
        async () => {
          const syncedWalletShim = {facade} as unknown as SyncedWallet;
          const entries = params.entries.map((e) => ({
            circuitId: e.circuitId,
            verifierKeyPath: resolvePath(e.verifierKeyPath),
          }));
          const result = await insertVerifierKeys({
            contractAddress: params.contractAddress,
            entries,
            keys: DUMMY_DERIVED_KEYS,
            walletKeys,
            network,
            artifactPath: artifact.path,
            syncedWallet: syncedWalletShim,
            projectDir: params.projectDir ? resolvePath(params.projectDir) : undefined,
            skipExisting: params.skipExisting,
            timeoutMs: params.timeoutSec ? params.timeoutSec * 1000 : 120_000,
            onProgress: (e) =>
              log('info', `[insertVerifierKeys] ${e.circuitId}: ${e.status}${e.txHash ? ` tx=${e.txHash}` : ''}`),
          });
          return {
            contractAddress: result.contractAddress,
            total: result.total,
            inserted: result.inserted,
            skipped: result.skipped,
            failed: result.failed,
            entries: result.entries,
          };
        },
        (r) => ({
          contractAddress: r.contractAddress,
          status: `${r.inserted}/${r.total} inserted (${r.skipped} skipped, ${r.failed} failed)`,
        }),
      );
    },
  };

  // Scope annotations. `getState` is the only read-class verb today;
  // everything else implicitly gets the server's default of 'write'.
  // Adding a new read-only verb? Tag it here so a read-scope key can
  // call it. Adding a write verb? Don't bother — the default already
  // covers it.
  handlers.getState.scope = 'read';

  return handlers;
}

function serializeBigintRecord(r: Record<string, bigint>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) out[k] = v.toString();
  return out;
}

function flattenTxResult(r: TransactionResult): {
  txHash: string;
  status: TransactionResult['status'];
  blockHash: string | null;
  blockHeight: number | null;
  contractAddress: string | null;
  fees: TransactionResult['fees'];
} {
  return {
    txHash: r.hash,
    status: r.status,
    blockHash: r.blockHash,
    blockHeight: r.blockHeight,
    contractAddress: r.contractAddress,
    fees: r.fees,
  };
}

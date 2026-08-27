// MCP tool registrations for `moth mcp`. Read tools are always
// registered; spend tools only when the command's consent gate passed
// (--auto-approve + MOTH_DAEMON_AUTO_APPROVE=1 + --max-spend).
//
// Spend tools delegate to core's buildWalletHandlers verbs so the
// max-spend cap, L3 approval queue, and audit logging ride inside the
// same handler bodies the daemon and TUI use — this file never
// reimplements a wallet operation that already has a daemon verb.
//
// Result convention: every success returns structuredContent (JSON,
// bigints as decimal strings per wallet-rpc-types.ts) plus a short
// human-readable text summary. Errors return isError with a
// "CODE: message" text — no exception ever escapes a tool callback,
// so agents always get a shaped result they can branch on.

import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {
  DaemonProtocolError,
  NIGHT_DENOMINATION,
  NIGHT_TOKEN_ID,
  decodeBech32mAddress,
  deriveActivity,
  estimateTransferFee,
  formatBalance,
  formatDustBalance,
  parseNightAmount,
  sortActivity,
  type ConnectionContext,
  type DaemonDustDeregisterResult,
  type DaemonDustRegisterResult,
  type DaemonGetStateResult,
  type DaemonSubmitTransactionResult,
  type DaemonTransferTokensResult,
  type WalletManager,
} from '@shieldedtech/moth-wallet';
import type {WalletRuntime} from './runtime.js';
import {serializeActivity, serializeBalances} from './serialize.js';
import {resolveTxInput} from './tx-input.js';

export interface McpToolDeps {
  readonly runtime: WalletRuntime;
  readonly walletManager: WalletManager;
}

export interface SpendToolConfig {
  /** Per-transaction NIGHT cap (raw STARS), enforced inside the
   *  transferTokens handler. NIGHT only — non-NIGHT tokens bypass it. */
  readonly maxSpendRaw: bigint;
  /** Also register balance_transaction (--allow-balancing): signs
   *  externally-built transactions whose value maxSpendRaw cannot see. */
  readonly allowBalancing: boolean;
}

/** Synthetic connection context for handler calls arriving over MCP
 *  stdio. Audit entries record it via the peer label; `remote` reuses
 *  'unix' because ConnectionContext's union has no MCP member (the
 *  trust model matches: same-UID local process). */
const MCP_CTX: ConnectionContext = {id: 0, remote: 'unix', peer: 'mcp-stdio'};

function ok(text: string, structured: unknown): CallToolResult {
  // The full JSON payload rides in the text block too: some MCP clients
  // surface only `content` to the model, and a summary alone would hide
  // fields it never mentions (measured: an agent reading just the
  // wallet_addresses summary couldn't see the shielded/dust addresses).
  return {
    content: [{type: 'text', text: `${text}\n\n${JSON.stringify(structured, null, 2)}`}],
    structuredContent: structured as Record<string, unknown>,
  };
}

function fail(text: string): CallToolResult {
  return {content: [{type: 'text', text}], isError: true};
}

function mapError(err: unknown): CallToolResult {
  if (err instanceof DaemonProtocolError) {
    return fail(`${err.code}: ${err.message}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return fail(`INTERNAL_ERROR: ${msg}`);
}

const NOT_READY_HINT =
  'wallet is still initializing — call wait_for_sync and retry';

/**
 * Resolve the amount inputs of transfer-shaped tools to raw base units.
 * Exactly one of amountNight / amountRaw must be given; amountNight is
 * NIGHT-only (other tokens have unknown decimals — raw units required).
 * Pure — unit-tested directly.
 */
export function resolveTransferAmount(input: {
  amountNight?: string;
  amountRaw?: string;
  tokenId: string;
}): {raw: bigint} | {error: string} {
  const hasNight = input.amountNight !== undefined;
  const hasRaw = input.amountRaw !== undefined;
  if (hasNight === hasRaw) {
    return {error: 'provide exactly one of amountNight or amountRaw'};
  }
  if (hasNight) {
    if (input.tokenId !== NIGHT_TOKEN_ID) {
      return {error: 'amountNight is only valid for the NIGHT token — pass amountRaw in the token\'s smallest unit'};
    }
    try {
      return {raw: parseNightAmount(input.amountNight!)};
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {error: `invalid amountNight: ${msg}`};
    }
  }
  if (!/^\d+$/.test(input.amountRaw!)) {
    return {error: 'amountRaw must be a decimal integer string (smallest units)'};
  }
  const raw = BigInt(input.amountRaw!);
  if (raw <= 0n) return {error: 'amountRaw must be positive'};
  return {raw};
}

function describeAmount(raw: bigint, tokenId: string): string {
  return tokenId === NIGHT_TOKEN_ID
    ? `${formatBalance(raw, NIGHT_DENOMINATION)} NIGHT`
    : `${raw.toString()} raw (token ${tokenId.slice(0, 12)}…)`;
}

const ADDRESS_KINDS: Record<string, string> = {
  'addr': 'unshielded (mn_addr_…)',
  'shield-addr': 'shielded (mn_shield-addr_…)',
  'dust': 'DUST (mn_dust_…)',
};

/**
 * Validate a transfer recipient beyond bare bech32m well-formedness:
 * the address kind must match the transfer type (unshielded → mn_addr_,
 * shielded → mn_shield-addr_) and its embedded network tag must match
 * the wallet's network — a cross-network send burns the funds. Returns
 * an error message or null. Pure — unit-tested directly.
 */
export function validateRecipient(
  to: string,
  transferType: 'unshielded' | 'shielded',
  networkId: string,
): string | null {
  let decoded: {type: string; network: string};
  try {
    decoded = decodeBech32mAddress(to.trim());
  } catch {
    return '`to` is not a well-formed Midnight bech32m address';
  }
  const expected = transferType === 'shielded' ? 'shield-addr' : 'addr';
  if (decoded.type !== expected) {
    const got = ADDRESS_KINDS[decoded.type] ?? `"${decoded.type}"`;
    return `\`to\` is a ${got} address, but a ${transferType} transfer needs a ${ADDRESS_KINDS[expected]} address`;
  }
  if (decoded.network !== networkId) {
    return `\`to\` is tagged for network "${decoded.network}", but this wallet is on "${networkId}" — a cross-network send loses the funds`;
  }
  return null;
}

const READ_ONLY = {readOnlyHint: true} as const;

export function registerReadTools(server: McpServer, deps: McpToolDeps): void {
  const rt = deps.runtime;

  server.registerTool(
    'wallet_status',
    {
      description:
        'Current wallet state: readiness, sync progress, and raw balance totals (decimal strings). ' +
        'syncState "starting" means the wallet engine is still initializing; "ready" means live (sync may still be catching up — check `synced`); "failed" means sync setup errored (see syncError).',
      annotations: READ_ONLY,
    },
    async (): Promise<CallToolResult> => {
      try {
        const state = (await rt.handlers.getState({}, MCP_CTX)) as DaemonGetStateResult;
        const structured = {
          ...state,
          syncState: rt.syncState,
          everSynced: rt.everSynced,
          ...(rt.syncError ? {syncError: rt.syncError} : {}),
        };
        const pct = state.syncProgress ? `${Math.round(state.syncProgress.percentage * 100)}%` : 'n/a';
        const text = state.ready
          ? `Wallet "${rt.walletName}" on ${rt.network.id}: ready, synced=${state.synced}, progress ${pct}.`
          : `Wallet "${rt.walletName}" on ${rt.network.id}: not ready (syncState=${rt.syncState}${rt.syncError ? `, error: ${rt.syncError}` : ''}).`;
        return ok(text, structured);
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    'wallet_balances',
    {
      description:
        'Detailed balances: NIGHT (unshielded/shielded/total, plus the spendable split — `unshieldedAvailable` is what a transfer can actually use; the headline figure includes coins reserved by in-flight transactions), DUST, and any non-NIGHT tokens. All amounts are decimal strings in smallest units (STARS for NIGHT, SPECK for DUST). Check `synced` — an unsynced snapshot may be incomplete.',
      annotations: READ_ONLY,
    },
    async (): Promise<CallToolResult> => {
      try {
        const b = rt.getBalances();
        if (!b) return fail(`INTERNAL_ERROR: ${NOT_READY_HINT}`);
        const s = serializeBalances(rt.walletName, rt.network.id, b);
        const reservedNote =
          s.night.unshieldedReserved !== '0'
            ? ` (${formatBalance(BigInt(s.night.unshieldedAvailable), NIGHT_DENOMINATION)} spendable — the rest is reserved by in-flight transactions)`
            : '';
        const text =
          `Wallet "${rt.walletName}" on ${rt.network.id}${b.synced ? '' : ' (still syncing — snapshot may be incomplete)'}: ` +
          `NIGHT total ${s.night.totalFormatted}${reservedNote}, DUST ${s.dust.formatted}.` +
          (s.otherTokens.length > 0 ? ` ${s.otherTokens.length} non-NIGHT token balance(s).` : '');
        return ok(text, s);
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    'wallet_addresses',
    {
      description:
        'Receive addresses for the unlocked wallet on the active network (bech32m). ' +
        '`night` (mn_addr_…) receives unshielded NIGHT and other unshielded tokens — also the wallet\'s identity in activity entries. ' +
        '`shielded` (mn_shield-addr_…) receives shielded tokens. ' +
        '`dust` (mn_dust_…) is the DUST address used for fee generation. ' +
        'Available immediately, even before sync completes.',
      annotations: READ_ONLY,
    },
    async (): Promise<CallToolResult> => {
      try {
        const a = rt.unlocked.addresses;
        const net = rt.network.id;
        const structured = {
          wallet: rt.walletName,
          network: net,
          addresses: {
            night: a.nightExternal.bech32m[net] ?? null,
            shielded: a.zswap.bech32m[net] ?? null,
            dust: a.dust.bech32m[net] ?? null,
          },
        };
        return ok(
          `Receive addresses for wallet "${rt.walletName}" on ${net} — night (unshielded), shielded (zswap), and dust.`,
          structured,
        );
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    'wallet_activity',
    {
      description:
        'Recent transaction history (newest first): direction, per-token net movements (decimal strings; negative = left the wallet), DUST movement, fees, counterparty when visible, and pending flag for locally-submitted transactions not yet on chain. Requires the wallet engine to be ready.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(20)
          .describe('Maximum number of entries to return (newest first).'),
      },
      annotations: READ_ONLY,
    },
    async ({limit}): Promise<CallToolResult> => {
      try {
        const facade = rt.getFacade();
        if (!facade) return fail(`INTERNAL_ERROR: ${NOT_READY_HINT}`);
        const ownAddress = rt.unlocked.addresses.nightExternal.bech32m[rt.network.id] ?? rt.unlocked.address;
        const entries = await facade.getAllFromTxHistory();
        const activity = sortActivity(deriveActivity(entries, ownAddress)).slice(0, limit);
        const structured = {
          wallet: rt.walletName,
          network: rt.network.id,
          synced: rt.getBalances()?.synced ?? false,
          total: entries.length,
          entries: serializeActivity(activity),
        };
        return ok(
          `${activity.length} of ${entries.length} history entries for wallet "${rt.walletName}" on ${rt.network.id} (newest first).`,
          structured,
        );
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    'wallet_list',
    {
      description:
        'All wallets known to this machine (~/.moth): name, primary address, network, active flag, optional label. Only the wallet this server was started with is unlocked and served by the other tools.',
      annotations: READ_ONLY,
    },
    async (): Promise<CallToolResult> => {
      try {
        const wallets = await deps.walletManager.list();
        const active = await deps.walletManager.getActive();
        const structured = {
          active,
          served: rt.walletName,
          wallets: wallets.map((w) => ({
            name: w.name,
            address: w.address,
            network: w.network,
            active: w.active,
            ...(w.label ? {label: w.label} : {}),
          })),
        };
        return ok(
          `${wallets.length} wallet(s) on this machine; active: ${active ?? '(none)'}; this server serves "${rt.walletName}".`,
          structured,
        );
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    'wait_for_sync',
    {
      description:
        'Block until the wallet has reached the chain tip at least once (synced=true), or until the timeout. Never fails on timeout — returns the latest progress; check `everSynced` to know whether balances/activity are authoritative. Note `synced` can flip back to false as new blocks arrive; `everSynced` latches.',
      inputSchema: {
        timeoutMs: z.number().int().min(1000).max(600_000).default(60_000)
          .describe('Maximum time to wait, in milliseconds (1s to 10min).'),
      },
      annotations: READ_ONLY,
    },
    async ({timeoutMs}): Promise<CallToolResult> => {
      try {
        const r = await rt.waitForSynced(timeoutMs);
        const pct = r.syncProgress ? `${Math.round(r.syncProgress.percentage * 100)}%` : 'n/a';
        const text = r.everSynced
          ? `Wallet reached the chain tip (waited ${r.elapsedMs}ms).`
          : `Timed out after ${r.elapsedMs}ms — sync at ${pct} (syncState=${r.syncState}). Balances may be incomplete; call wait_for_sync again with a longer timeout.`;
        return ok(text, {...r});
      } catch (err) {
        return mapError(err);
      }
    },
  );
}

export function registerSpendTools(server: McpServer, deps: McpToolDeps, cfg: SpendToolConfig): void {
  const rt = deps.runtime;
  const capLabel = `${formatBalance(cfg.maxSpendRaw, NIGHT_DENOMINATION)} NIGHT`;

  /** Spend paths need a synced wallet: coin selection against a stale
   *  state builds transactions the node rejects. Refuse deterministically
   *  instead. */
  const requireSynced = async (syncWaitMs: number): Promise<CallToolResult | null> => {
    const r = await rt.waitForSynced(syncWaitMs);
    if (r.everSynced) return null;
    const pct = r.syncProgress ? `${Math.round(r.syncProgress.percentage * 100)}%` : 'n/a';
    return fail(
      `INTERNAL_ERROR: wallet has not reached the chain tip yet (sync at ${pct}, syncState=${r.syncState}) — ` +
      'call wait_for_sync with a longer timeout, then retry',
    );
  };

  const amountInputSchema = {
    to: z.string().describe('Recipient bech32m address.'),
    amountNight: z.string().optional()
      .describe('Decimal NIGHT amount, e.g. "1.5" (up to 6 decimals). NIGHT only. Provide exactly one of amountNight / amountRaw.'),
    amountRaw: z.string().optional()
      .describe('Amount as a decimal integer string in the token\'s smallest unit (STARS for NIGHT). Required for non-NIGHT tokens.'),
    tokenId: z.string().regex(/^[0-9a-f]{64}$/).default(NIGHT_TOKEN_ID)
      .describe('64-char hex token id. Defaults to NIGHT.'),
    type: z.enum(['unshielded', 'shielded']).default('unshielded')
      .describe('Transfer kind. `shielded` requires a shielded recipient address.'),
  };

  server.registerTool(
    'transfer_tokens',
    {
      description:
        `Send tokens from this wallet. Auto-approved (no human confirmation) and audited to ~/.moth/daemon-audit.log. ` +
        `NIGHT transfers above the operator's per-transaction cap of ${capLabel} are refused; the cap applies to NIGHT only. ` +
        'The recipient kind must match the transfer type — unshielded needs an mn_addr_… address, shielded an mn_shield-addr_… address — and its network tag must match this wallet\'s network (both validated). ' +
        'Waits for the wallet to reach the chain tip first (syncWaitMs). Returns the transaction id.',
      inputSchema: {
        ...amountInputSchema,
        syncWaitMs: z.number().int().min(0).max(300_000).default(120_000)
          .describe('How long to wait for sync before building the transaction, in milliseconds.'),
      },
      annotations: {destructiveHint: true},
    },
    async (input): Promise<CallToolResult> => {
      try {
        const amount = resolveTransferAmount(input);
        if ('error' in amount) return fail(`INVALID_PARAMS: ${amount.error}`);
        const badRecipient = validateRecipient(input.to, input.type, rt.network.id);
        if (badRecipient) return fail(`INVALID_PARAMS: ${badRecipient}`);
        const notSynced = await requireSynced(input.syncWaitMs);
        if (notSynced) return notSynced;

        const result = (await rt.handlers.transferTokens(
          {
            type: input.type,
            tokenId: input.tokenId,
            amount: amount.raw.toString(),
            to: input.to,
          },
          MCP_CTX,
        )) as DaemonTransferTokensResult;

        const structured = {
          txId: result.txId,
          amountRaw: amount.raw.toString(),
          tokenId: input.tokenId,
          type: input.type,
          to: input.to,
          maxSpendNight: capLabel,
        };
        return ok(
          `Sent ${describeAmount(amount.raw, input.tokenId)} (${input.type}) to ${input.to} — txId ${result.txId}.`,
          structured,
        );
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    'estimate_transfer_fee',
    {
      description:
        'Estimate the DUST fee for a transfer without sending it (includes the balancing transaction that pays the fee). Same inputs as transfer_tokens. Waits for the wallet to reach the chain tip first.',
      inputSchema: {
        ...amountInputSchema,
        syncWaitMs: z.number().int().min(0).max(300_000).default(120_000)
          .describe('How long to wait for sync before estimating, in milliseconds.'),
      },
      annotations: READ_ONLY,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const amount = resolveTransferAmount(input);
        if ('error' in amount) return fail(`INVALID_PARAMS: ${amount.error}`);
        const badRecipient = validateRecipient(input.to, input.type, rt.network.id);
        if (badRecipient) return fail(`INVALID_PARAMS: ${badRecipient}`);
        const notSynced = await requireSynced(input.syncWaitMs);
        if (notSynced) return notSynced;
        const facade = rt.getFacade();
        if (!facade) return fail(`INTERNAL_ERROR: ${NOT_READY_HINT}`);

        const fee = await estimateTransferFee(facade, rt.getWalletKeys(), rt.network.id, [
          {type: input.type, tokenId: input.tokenId, amount: amount.raw, to: input.to},
        ]);
        const structured = {
          feeSpeck: fee.toString(),
          feeFormatted: formatDustBalance(fee),
          amountRaw: amount.raw.toString(),
          tokenId: input.tokenId,
          type: input.type,
          to: input.to,
        };
        return ok(
          `Estimated fee for sending ${describeAmount(amount.raw, input.tokenId)}: ${structured.feeFormatted} DUST (${structured.feeSpeck} SPECK).`,
          structured,
        );
      } catch (err) {
        return mapError(err);
      }
    },
  );

  if (cfg.allowBalancing) {
    server.registerTool(
      'balance_transaction',
      {
        description:
          'Balance — and for unproven input, prove — an externally-built transaction (dApp-connector flow): this wallet pays its fees, adds inputs/outputs to remove imbalances, generates missing proofs, and signs it — e.g. a payment transaction generated by a website\'s endpoint to unlock paid access. ' +
          'Pass the transaction inline as hex (txHex) or as a file path (txFile) — exactly one of the two. ' +
          'By default the result is also submitted and the transaction id returned; with submit=false the balanced FinalizedTransaction hex is returned instead (hand it back to the site if the site submits). ' +
          'CAUTION: the value this moves is opaque to the wallet — the operator\'s max-spend cap does NOT apply; the wallet funds whatever the transaction needs. Only balance transactions from endpoints the user asked you to pay. ' +
          'Auto-approved and audited. Waits for the wallet to reach the chain tip first.',
        inputSchema: {
          txHex: z.string().regex(/^([0-9a-fA-F]{2})+$/).optional()
            .describe('Hex-encoded transaction to balance, as produced by the dApp/site endpoint. Provide exactly one of txHex / txFile.'),
          txFile: z.string().optional()
            .describe('Path to a file holding the transaction — hex text (whitespace and 0x prefix tolerated) or raw binary — read on the machine running the moth mcp server. Provide exactly one of txHex / txFile.'),
          stage: z.enum(['sealed', 'unsealed', 'unproven'])
            .describe('The transaction\'s stage: `unproven` (most common from dApps — carries no proofs yet; the wallet proves it), `unsealed` (proven, pre-binding), `sealed` (proven and bound). If deserialization fails, retry with another stage.'),
          submit: z.boolean().default(true)
            .describe('Submit the balanced transaction (returns txId). false returns the balanced hex without submitting.'),
          syncWaitMs: z.number().int().min(0).max(300_000).default(120_000)
            .describe('How long to wait for sync before balancing, in milliseconds.'),
        },
        annotations: {destructiveHint: true},
      },
      async ({txHex, txFile, stage, submit, syncWaitMs}): Promise<CallToolResult> => {
        try {
          // Resolve the input before the sync wait: a bad path or a
          // both/neither mistake should fail immediately, not after
          // blocking up to syncWaitMs.
          const tx = await resolveTxInput({txHex, txFile});
          if ('error' in tx) return fail(`INVALID_PARAMS: ${tx.error}`);
          const notSynced = await requireSynced(syncWaitMs);
          if (notSynced) return notSynced;
          const result = (await rt.handlers.balanceTransaction(
            {hex: tx.hex, stage, submit},
            MCP_CTX,
          )) as {submitted: boolean; txId: string | null; finalizedHex: string | null};
          return ok(
            result.submitted
              ? `Balanced and submitted the transaction — txId ${result.txId}.`
              : `Balanced the transaction (not submitted) — ${Math.floor((result.finalizedHex?.length ?? 0) / 2)} bytes of FinalizedTransaction hex returned.`,
            {...result},
          );
        } catch (err) {
          return mapError(err);
        }
      },
    );
  }

  if (cfg.allowBalancing) {
    server.registerTool(
      'submit_transaction',
      {
        description:
          'Submit a pre-built, fully-balanced FinalizedTransaction to the network and return its transaction id. ' +
          'Pass the transaction inline as hex (txHex) or as a file path (txFile) — exactly one of the two. ' +
          'Use this when a dApp/site hands over a transaction that needs no balancing — if it still needs its fees paid, use balance_transaction instead (which can also submit). ' +
          'CAUTION: the value this moves is opaque to the wallet — the operator\'s max-spend cap does NOT apply. Only submit transactions the user asked you to send. ' +
          'Auto-approved and audited.',
        inputSchema: {
          txHex: z.string().regex(/^([0-9a-fA-F]{2})+$/).optional()
            .describe('Hex-encoded FinalizedTransaction (output of tx.serialize()), e.g. the finalizedHex returned by balance_transaction with submit=false. Provide exactly one of txHex / txFile.'),
          txFile: z.string().optional()
            .describe('Path to a file holding the FinalizedTransaction — hex text (whitespace and 0x prefix tolerated) or raw binary — read on the machine running the moth mcp server. Provide exactly one of txHex / txFile.'),
        },
        annotations: {destructiveHint: true},
      },
      async ({txHex, txFile}): Promise<CallToolResult> => {
        try {
          const tx = await resolveTxInput({txHex, txFile});
          if ('error' in tx) return fail(`INVALID_PARAMS: ${tx.error}`);
          if (!rt.getFacade()) return fail(`INTERNAL_ERROR: ${NOT_READY_HINT}`);
          const result = (await rt.handlers.submitTransaction(
            {hex: tx.hex},
            MCP_CTX,
          )) as DaemonSubmitTransactionResult;
          return ok(`Submitted the transaction — txId ${result.txId}.`, {...result});
        } catch (err) {
          return mapError(err);
        }
      },
    );
  }

  server.registerTool(
    'dust_register',
    {
      description:
        'Register every currently-unregistered NIGHT UTXO for DUST generation (DUST pays transaction fees). Auto-approved and audited. Returns the transaction id, or registered=false when there was nothing to register. Waits for the wallet to reach the chain tip first.',
      inputSchema: {
        receiver: z.string().optional()
          .describe('Optional dust receiver address; defaults to this wallet.'),
        syncWaitMs: z.number().int().min(0).max(300_000).default(120_000)
          .describe('How long to wait for sync first, in milliseconds.'),
      },
      annotations: {destructiveHint: true},
    },
    async ({receiver, syncWaitMs}): Promise<CallToolResult> => {
      try {
        const notSynced = await requireSynced(syncWaitMs);
        if (notSynced) return notSynced;
        const result = (await rt.handlers.dustRegister(
          receiver ? {receiver} : {},
          MCP_CTX,
        )) as DaemonDustRegisterResult;
        return ok(
          result.registered
            ? `Registered NIGHT UTXOs for DUST generation — txId ${result.txId}.`
            : 'Nothing to register — every NIGHT UTXO is already registered for DUST generation.',
          {...result},
        );
      } catch (err) {
        return mapError(err);
      }
    },
  );

  server.registerTool(
    'dust_deregister',
    {
      description:
        'Deregister every currently-registered NIGHT UTXO from DUST generation (DUST stops accruing from them). Auto-approved and audited. Waits for the wallet to reach the chain tip first.',
      inputSchema: {
        syncWaitMs: z.number().int().min(0).max(300_000).default(120_000)
          .describe('How long to wait for sync first, in milliseconds.'),
      },
      annotations: {destructiveHint: true},
    },
    async ({syncWaitMs}): Promise<CallToolResult> => {
      try {
        const notSynced = await requireSynced(syncWaitMs);
        if (notSynced) return notSynced;
        const result = (await rt.handlers.dustDeregister({}, MCP_CTX)) as DaemonDustDeregisterResult;
        return ok(
          `Deregistered NIGHT UTXOs from DUST generation — txId ${result.txId}.`,
          {...result},
        );
      } catch (err) {
        return mapError(err);
      }
    },
  );
}

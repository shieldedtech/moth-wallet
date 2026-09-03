// Midnight dApp connector API implementation (background side). Dispatches
// `connectorRequest` messages relayed by the content script. The requesting
// origin comes exclusively from the message sender — never from the page.
//
// Orchestration (permission + approval + session gating, error shaping) runs
// here; the actual wallet/ledger work (balances, transfers) is delegated to the
// offscreen document, which owns the WASM.

import type { DesiredInput, DesiredOutput, Configuration, ConnectionStatus } from '@midnight-ntwrk/dapp-connector-api';
import type { WalletBalances } from '@shieldedtech/moth-browser';
import { resolveProverConfig } from '@shieldedtech/moth-wallet/types/network';
import { onMessage, deserializeBalances } from '../messaging/protocol';
import { encodeBigintJson, decodeBigintJson } from '../messaging/bigint-json';
import { connectorError, describeErrorFields, serializeError, type ErrorCode } from '../connector/errors';
import { NOT_IMPLEMENTED_METHODS, type ConnectorMethod } from '../connector/constants';
import type { TransferRequestDTO, SwapInputDTO, ProvingKeyMaterialDTO } from '../offscreen/messaging';
import { getSettings, getNetworkConfig } from './settings';
import { getSession, type Session } from './session';
import { isAllowed, grant, revoke, listAll } from './permissions';
import {
  requestApproval,
  prepareApprovalPanel,
  getApproval,
  getPendingApproval,
  resolveApproval,
} from './approvals';
import { beginOp, endOp } from './sync-service';
import { offscreen } from './offscreen-client';

// These methods can display an approval. Their panel-open attempt starts at
// dispatch entry, before any permission/session/storage await consumes the
// user activation relayed synchronously by the content script.
const APPROVAL_METHODS = new Set<ConnectorMethod>([
  'connect',
  'hintUsage',
  'signData',
  'deriveAppSecret',
  'balanceSealedTransaction',
  'balanceUnsealedTransaction',
  'makeIntent',
  'makeTransfer',
]);

// A dapp commonly requests all three balance views together. They are slices
// of the same WalletBalances snapshot, so coalesce concurrent reads for one
// unlocked wallet instead of starting parallel offscreen sync requests.
const pendingBalanceSnapshots = new Map<string, Promise<WalletBalances>>();

function assertTxHex(hex: string): string {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw connectorError('InvalidRequest', 'Transaction must be a hex string');
  }
  return hex;
}

function assertBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw connectorError('InvalidRequest', `${label} must be a Uint8Array`);
  }
  return value;
}

function assertKeyMaterial(value: unknown): ProvingKeyMaterialDTO {
  if (!value || typeof value !== 'object') {
    throw connectorError('InvalidRequest', 'Proving key material is required');
  }
  const material = value as Partial<ProvingKeyMaterialDTO>;
  return {
    zkir: assertBytes(material.zkir, 'ZKIR'),
    proverKey: assertBytes(material.proverKey, 'Prover key'),
    verifierKey: assertBytes(material.verifierKey, 'Verifier key'),
  };
}

function toWsUrl(url: string): string {
  return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw connectorError('Disconnected', 'Wallet is locked');
  return session;
}

async function requireConnected(origin: string): Promise<Session> {
  if (!(await isAllowed(origin))) {
    throw connectorError('PermissionRejected', `${origin} is not authorized; call connect() first`);
  }
  return requireSession();
}

// Grant the origin, prompting the user first when it isn't already connected
// (not yet allowed, or the wallet is locked). Resolves only once the origin is
// granted and the wallet unlocked; rejects with `Rejected` if the user
// declines. Shared by connect() and hintUsage(). The approval surface also
// offers unlock when the wallet is locked.
async function ensureConnected(
  origin: string,
  networkId: string,
  senderTabId?: number,
  preparedPanel?: Promise<boolean>,
): Promise<void> {
  const allowed = await isAllowed(origin);
  const session = await getSession();
  if (!allowed || !session) {
    const approved = await requestApproval('connect', origin, { networkId }, senderTabId, preparedPanel);
    if (!approved) throw connectorError('Rejected', 'User rejected the connection request');
    await requireSession();
  }
  await grant(origin, networkId);
}

async function syncedBalances(session: Session): Promise<WalletBalances> {
  const network = await getNetworkConfig();
  const prover = resolveProverConfig(network);
  const key = [
    session.walletName,
    String(session.unlockedAt),
    network.id,
    network.nodeUrl,
    network.indexerUrl,
    prover.type,
    prover.type === 'server' ? prover.url : '',
  ].join('\u0000');
  const pending = pendingBalanceSnapshots.get(key);
  if (pending) return pending;

  const loading = offscreen
    .balancesGet({
      seedHex: session.seedHex,
      walletName: session.walletName,
      network,
    })
    .then(deserializeBalances);
  pendingBalanceSnapshots.set(key, loading);

  const clear = () => {
    if (pendingBalanceSnapshots.get(key) === loading) pendingBalanceSnapshots.delete(key);
  };
  void loading.then(clear, clear);
  return loading;
}

function addressFor(session: Session, role: keyof Session['addresses'], networkId: string): string {
  const encoded = session.addresses[role]?.bech32m ?? {};
  return encoded[networkId] ?? Object.values(encoded)[0] ?? '';
}

// Shared by balanceSealedTransaction / balanceUnsealedTransaction: validate the
// tx hex, prompt for approval (balancing spends wallet funds to cover fees and
// imbalances), then balance + prove in the offscreen host. `sealed` selects the
// input binding stage.
async function balance(
  origin: string,
  sealed: boolean,
  params: unknown[],
  senderTabId?: number,
  preparedPanel?: Promise<boolean>,
): Promise<{ tx: string }> {
  const session = await requireConnected(origin);
  const tx = assertTxHex(String(params[0] ?? ''));
  const options = (params[1] ?? {}) as { payFees?: boolean };
  if (options.payFees === false) {
    throw connectorError('InvalidRequest', 'Moth always pays fees; payFees: false is unsupported');
  }
  const approved = await requestApproval('balance', origin, { sealed }, senderTabId, preparedPanel);
  if (!approved) throw connectorError('Rejected', 'User rejected the transaction');

  const network = await getNetworkConfig();
  const { txHex } = await offscreen.balanceTransaction({
    seedHex: session.seedHex,
    walletName: session.walletName,
    network,
    txHex: tx,
    sealed,
  });
  return { tx: txHex };
}

// Exported for unit testing; the message handler below is the only production
// caller. Brackets the entire request as ONE in-flight op — this holds the
// keepalive and blocks idle teardown (via the op counter + lifecycle epoch) for
// the whole call. Without it, a read-only op (balances/history/signData) landing
// after teardown would recreate the offscreen document and start sync but never
// fire endOp, so teardown would never be rescheduled and the wallet would sync
// forever; a pending teardown timer could also close the document mid-request.
// The counter is refcounted, so this composes with any nested op.
export async function dispatch(
  origin: string,
  method: ConnectorMethod,
  params: unknown[],
  senderTabId?: number,
): Promise<unknown> {
  const preparedPanel = APPROVAL_METHODS.has(method) ? prepareApprovalPanel(senderTabId) : undefined;
  beginOp();
  try {
    return await dispatchMethod(origin, method, params, senderTabId, preparedPanel);
  } finally {
    endOp();
  }
}

async function dispatchMethod(
  origin: string,
  method: ConnectorMethod,
  params: unknown[],
  senderTabId?: number,
  preparedPanel?: Promise<boolean>,
): Promise<unknown> {
  if ((NOT_IMPLEMENTED_METHODS as readonly string[]).includes(method)) {
    throw connectorError('InternalError', `${method} is not implemented by Moth (reference wallet MVP)`);
  }

  switch (method) {
    case 'connect': {
      const networkId = String(params[0] ?? '');
      const settings = await getSettings();
      if (networkId !== settings.network) {
        throw connectorError('InvalidRequest', `Wallet is connected to "${settings.network}", not "${networkId}"`);
      }
      await ensureConnected(origin, networkId, senderTabId, preparedPanel);
      return true;
    }

    case 'hintUsage': {
      // The dApp hints which methods it intends to use so the wallet can ask
      // the user for permission ahead of time. Moth grants per origin all at
      // once, so we treat a hint as a connection request: prompt when the
      // origin isn't already connected and resolve only after the user grants
      // (spec: "resolve the promise only after the user has granted the
      // permissions"). Already-connected origins resolve without a prompt.
      const settings = await getSettings();
      await ensureConnected(origin, settings.network, senderTabId, preparedPanel);
      return undefined;
    }

    case 'getConnectionStatus': {
      const settings = await getSettings();
      const session = await getSession();
      const allowed = await isAllowed(origin);
      const status: ConnectionStatus =
        allowed && session
          ? { status: 'connected', networkId: settings.network }
          : { status: 'disconnected' };
      return status;
    }

    case 'getConfiguration': {
      await requireConnected(origin);
      const network = await getNetworkConfig();
      const prover = resolveProverConfig(network);
      const configuration: Configuration = {
        indexerUri: network.indexerUrl,
        indexerWsUri: toWsUrl(network.indexerUrl) + '/ws',
        ...(prover.type === 'server' ? { proverServerUri: prover.url } : {}),
        substrateNodeUri: network.nodeUrl,
        networkId: network.id,
      };
      return configuration;
    }

    case 'getProvingProvider': {
      await requireConnected(origin);
      // The callable provider remains in the page; this handshake verifies the
      // connection before the injected proxy returns it.
      return true;
    }

    case 'provingProviderCheck':
    case 'provingProviderProve': {
      await requireConnected(origin);
      const serializedPreimage = assertBytes(params[0], 'Serialized preimage');
      const keyLocation = params[1];
      if (typeof keyLocation !== 'string' || keyLocation === '') {
        throw connectorError('InvalidRequest', 'Circuit key location must be a non-empty string');
      }
      const keyMaterial = assertKeyMaterial(params[2]);
      const network = await getNetworkConfig();
      if (method === 'provingProviderCheck') {
        return offscreen.provingProviderCheck({network, serializedPreimage, keyLocation, keyMaterial});
      }
      const overwriteBindingInput = params[3];
      if (overwriteBindingInput !== undefined && typeof overwriteBindingInput !== 'bigint') {
        throw connectorError('InvalidRequest', 'overwriteBindingInput must be a bigint');
      }
      return offscreen.provingProviderProve({
        network,
        serializedPreimage,
        keyLocation,
        keyMaterial,
        overwriteBindingInput,
      });
    }

    case 'getShieldedBalances': {
      const session = await requireConnected(origin);
      return (await syncedBalances(session)).shielded;
    }

    case 'getUnshieldedBalances': {
      const session = await requireConnected(origin);
      return (await syncedBalances(session)).unshielded;
    }

    case 'getDustBalance': {
      const session = await requireConnected(origin);
      const balances = await syncedBalances(session);
      return { cap: balances.dustGeneration?.limit ?? 0n, balance: balances.dust };
    }

    case 'getShieldedAddresses': {
      const session = await requireConnected(origin);
      const settings = await getSettings();
      return {
        shieldedAddress: addressFor(session, 'zswap', settings.network),
        shieldedCoinPublicKey: session.shieldedCoinPublicKey,
        shieldedEncryptionPublicKey: session.shieldedEncryptionPublicKey,
      };
    }

    case 'getUnshieldedAddress': {
      const session = await requireConnected(origin);
      const settings = await getSettings();
      return { unshieldedAddress: addressFor(session, 'nightExternal', settings.network) };
    }

    case 'getDustAddress': {
      const session = await requireConnected(origin);
      const settings = await getSettings();
      return { dustAddress: addressFor(session, 'dust', settings.network) };
    }

    case 'getTxHistory': {
      const session = await requireConnected(origin);
      const pageNumber = Number(params[0]);
      const pageSize = Number(params[1]);
      if (!Number.isInteger(pageNumber) || pageNumber < 0 || !Number.isInteger(pageSize) || pageSize <= 0) {
        throw connectorError('InvalidRequest', 'getTxHistory requires pageNumber (>= 0) and pageSize (>= 1)');
      }
      const network = await getNetworkConfig();
      return offscreen.txHistoryGet({
        seedHex: session.seedHex,
        walletName: session.walletName,
        network,
        pageNumber,
        pageSize,
      });
    }

    case 'signData': {
      const session = await requireConnected(origin);
      const data = params[0];
      const options = (params[1] ?? {}) as { encoding?: unknown; keyType?: unknown };
      if (typeof data !== 'string') {
        throw connectorError('InvalidRequest', 'signData requires the data as a string');
      }
      if (options.keyType !== 'unshielded') {
        throw connectorError('InvalidRequest', 'signData supports only keyType "unshielded"');
      }
      const encoding = options.encoding;
      if (encoding !== 'hex' && encoding !== 'base64' && encoding !== 'text') {
        throw connectorError('InvalidRequest', 'signData encoding must be "hex", "base64", or "text"');
      }
      // Signing uses the same key that authorizes transactions, so each request
      // needs explicit user consent (the offscreen host applies the
      // domain-separation prefix that keeps a message from being a valid tx).
      const approved = await requestApproval(
        'signData',
        origin,
        { encoding, message: data },
        senderTabId,
        preparedPanel,
      );
      if (!approved) throw connectorError('Rejected', 'User rejected the signing request');

      const network = await getNetworkConfig();
      try {
        return await offscreen.signData({ seedHex: session.seedHex, network, data, encoding });
      } catch (err) {
        // The realistic failure here is malformed hex/base64 input.
        throw connectorError('InvalidRequest', (err as Error).message ?? 'Failed to sign data');
      }
    }

    // Wallet extension method (not in dapp-connector-api). Derives a
    // deterministic, private, per-(origin, domain) app secret. See
    // specs/003-derive-app-secret.
    case 'deriveAppSecret': {
      const session = await requireConnected(origin);
      const domain = params[0];
      // Short printable-ASCII label — reject control chars / oversized input.
      if (
        typeof domain !== 'string' ||
        domain.length === 0 ||
        domain.length > 128 ||
        // eslint-disable-next-line no-control-regex
        /[^\x20-\x7e]/.test(domain)
      ) {
        throw connectorError(
          'InvalidRequest',
          'deriveAppSecret requires a short printable-ASCII domain string (1–128 chars)',
        );
      }
      const approved = await requestApproval(
        'deriveAppSecret',
        origin,
        { domain },
        senderTabId,
        preparedPanel,
      );
      if (!approved) throw connectorError('Rejected', 'User rejected the derivation request');

      // CRITICAL: origin comes from the connection session (bound by the
      // wallet), NEVER from params — that is what stops site B deriving
      // site A's secret. Do not add an origin parameter.
      return await offscreen.deriveAppSecret({ seedHex: session.seedHex, origin, domain });
    }

    case 'balanceSealedTransaction':
      return balance(origin, true, params, senderTabId, preparedPanel);

    case 'balanceUnsealedTransaction':
      return balance(origin, false, params, senderTabId, preparedPanel);

    case 'makeIntent': {
      const session = await requireConnected(origin);
      const inputs = (params[0] ?? []) as DesiredInput[];
      const outputs = (params[1] ?? []) as DesiredOutput[];
      const options = (params[2] ?? {}) as { payFees?: boolean };
      if (!Array.isArray(inputs) || !Array.isArray(outputs) || inputs.length + outputs.length === 0) {
        throw connectorError('InvalidRequest', 'makeIntent requires at least one input or output');
      }
      if (options.payFees === false) {
        throw connectorError('InvalidRequest', 'Moth always pays fees; payFees: false is unsupported');
      }
      const inputDtos: SwapInputDTO[] = inputs.map((input) => {
        if (input.kind !== 'shielded' && input.kind !== 'unshielded') {
          throw connectorError('InvalidRequest', `Unknown input kind: ${String(input.kind)}`);
        }
        return { type: input.kind, tokenId: input.type, amount: String(input.value) };
      });
      const outputDtos: TransferRequestDTO[] = outputs.map((out) => {
        if (out.kind !== 'shielded' && out.kind !== 'unshielded') {
          throw connectorError('InvalidRequest', `Unknown output kind: ${String(out.kind)}`);
        }
        return { type: out.kind, tokenId: out.type, amount: String(out.value), to: out.recipient };
      });

      const approved = await requestApproval(
        'transfer',
        origin,
        { outputs: outputs.map((out) => ({ ...out, value: out.value.toString() })) },
        senderTabId,
        preparedPanel,
      );
      if (!approved) throw connectorError('Rejected', 'User rejected the transaction');

      const network = await getNetworkConfig();
      const { txHex } = await offscreen.makeIntent({
        seedHex: session.seedHex,
        walletName: session.walletName,
        network,
        inputs: inputDtos,
        outputs: outputDtos,
        payFees: true,
      });
      return { tx: txHex };
    }

    case 'makeTransfer': {
      const session = await requireConnected(origin);
      const outputs = (params[0] ?? []) as DesiredOutput[];
      const options = (params[1] ?? {}) as { payFees?: boolean };
      if (!Array.isArray(outputs) || outputs.length === 0) {
        throw connectorError('InvalidRequest', 'makeTransfer requires at least one desired output');
      }
      if (options.payFees === false) {
        throw connectorError('InvalidRequest', 'Moth always pays fees; payFees: false is unsupported');
      }
      const requests: TransferRequestDTO[] = outputs.map((out) => {
        if (out.kind !== 'shielded' && out.kind !== 'unshielded') {
          throw connectorError('InvalidRequest', `Unknown output kind: ${String(out.kind)}`);
        }
        return { type: out.kind, tokenId: out.type, amount: String(out.value), to: out.recipient };
      });

      const approved = await requestApproval(
        'transfer',
        origin,
        { outputs: outputs.map((out) => ({ ...out, value: out.value.toString() })) },
        senderTabId,
        preparedPanel,
      );
      if (!approved) throw connectorError('Rejected', 'User rejected the transfer');

      const network = await getNetworkConfig();
      const { txHex } = await offscreen.transferBuild({
        seedHex: session.seedHex,
        walletName: session.walletName,
        network,
        requests,
      });
      return { tx: txHex };
    }

    case 'submitTransaction': {
      const session = await requireConnected(origin);
      const txHex = assertTxHex(String(params[0] ?? ''));
      const network = await getNetworkConfig();
      await offscreen.transferSubmit({
        seedHex: session.seedHex,
        walletName: session.walletName,
        network,
        txHex,
      });
      return undefined;
    }

    default:
      throw connectorError('InvalidRequest', `Unknown method: ${String(method)}`);
  }
}

function senderOrigin(sender: { origin?: string; url?: string } | undefined): string | null {
  if (sender?.origin) return sender.origin;
  if (sender?.url) {
    try {
      return new URL(sender.url).origin;
    } catch {
      return null;
    }
  }
  return null;
}

export function registerConnectorHandlers(): void {
  onMessage('connectorRequest', async ({ data, sender }) => {
    const origin = senderOrigin(sender?.tab ? { url: sender.tab.url } : sender);
    if (!origin) {
      return { ok: false as const, error: serializeError('InvalidRequest', 'Could not determine request origin') };
    }
    try {
      const params = decodeBigintJson<unknown[]>(data.paramsJson);
      const result = await dispatch(origin, data.method as ConnectorMethod, params, sender?.tab?.id);
      return { ok: true as const, resultJson: encodeBigintJson(result ?? null) };
    } catch (err) {
      const code: ErrorCode = (err as { code?: ErrorCode }).code ?? 'InternalError';
      const base = (err as { reason?: string; message?: string }).reason ?? (err as Error).message ?? String(err);
      // Fold the error's structured fields into the reason. Without this a DApp
      // only ever sees the message, and SDK errors keep the useful part (e.g.
      // InsufficientFundsError's tokenType and amount) in their fields.
      const detail = describeErrorFields(err);
      const reason = detail ? `${base} [${detail}]` : base;
      return { ok: false as const, error: serializeError(code, reason) };
    }
  });

  onMessage('approvalGet', async ({ data }) => {
    const approval = await getApproval(data.id);
    const session = await getSession();
    return { approval, locked: !session };
  });

  onMessage('approvalResolve', ({ data }) => {
    resolveApproval(data.id, data.approved);
  });

  onMessage('approvalPending', async () => {
    const approval = await getPendingApproval();
    const session = await getSession();
    return { approval, locked: !session };
  });

  onMessage('networkConfigGet', async () => {
    const network = await getNetworkConfig();
    return {
      id: network.id,
      nodeUrl: network.nodeUrl,
      indexerUrl: network.indexerUrl,
      prover: resolveProverConfig(network),
    };
  });

  onMessage('permissionsList', () => listAll());

  onMessage('permissionsRevoke', async ({ data }) => {
    await revoke(data.origin);
  });
}

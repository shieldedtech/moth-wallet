// The Midnight DApp connector for Moth's in-app browser: the extension's dispatch
// (packages/extension/lib/background/connector-handlers.ts) with approvals answered by Swift.
//
// The origin is supplied by Swift from the requesting frame's security origin, never by the page.
import type { ConnectionStatus, Configuration, DesiredInput, DesiredOutput, ErrorCode } from '@midnight-ntwrk/dapp-connector-api';
import type { APIError } from '@midnight-ntwrk/dapp-connector-api';
import { connectorError, describeErrorFields } from 'moth-ext/connector/errors';
import { encodeBigintJson, decodeBigintJson } from 'moth-ext/messaging/bigint-json';
import type { ProvingKeyMaterialDTO, SwapInputDTO, TransferRequestDTO, TxSummaryDTO } from 'moth-ext/offscreen/messaging';
import { deserializeBalances } from 'moth-ext/messaging/balances-json';
import { addressOn, call, emit, networkConfig, sessions, type Session } from './host';

// --- Grants ------------------------------------------------------------------------

interface Grant {
  networkId: string;
  grantedAt: number;
}

const GRANTS_KEY = 'moth.connector.grants';

function loadGrants(): Record<string, Grant> {
  try {
    return JSON.parse(localStorage.getItem(GRANTS_KEY) ?? '{}') as Record<string, Grant>;
  } catch {
    return {};
  }
}

function saveGrants(grants: Record<string, Grant>): void {
  localStorage.setItem(GRANTS_KEY, JSON.stringify(grants));
}

// A grant covers one network: a site approved on preprod is not connected on another network.
const isAllowed = (origin: string, networkId: string) => loadGrants()[origin]?.networkId === networkId;

// --- Active wallet -----------------------------------------------------------------------

let active: { name: string; network: string } | null = null;

function requireSession(): { session: Session; name: string; network: string } {
  const session = active && sessions.get(active.name);
  if (!active || !session) throw connectorError('Disconnected', 'Wallet is locked');
  return { session, ...active };
}

function requireConnected(origin: string) {
  const current = requireSession();
  if (!isAllowed(origin, current.network)) {
    throw connectorError('PermissionRejected', `${origin} is not authorized; call connect() first`);
  }
  return current;
}

// --- Approvals ---------------------------------------------------------------------------

let nextApproval = 1;
const approvals = new Map<number, (approved: boolean) => void>();

function requestApproval(kind: string, origin: string, payload: unknown): Promise<boolean> {
  const id = nextApproval++;
  return new Promise((resolve) => {
    approvals.set(id, resolve);
    emit({ event: 'approval', data: { id, origin, kind, payload } });
  });
}

async function approve(kind: string, origin: string, payload: unknown, rejection: string): Promise<void> {
  if (!(await requestApproval(kind, origin, payload))) throw connectorError('Rejected', rejection);
}

// --- Validation (as connector-handlers.ts) ---------------------------------------------

function assertTxHex(hex: string): string {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw connectorError('InvalidRequest', 'Transaction must be a hex string');
  }
  return hex;
}

function assertBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw connectorError('InvalidRequest', `${label} must be a Uint8Array`);
  return value;
}

function assertKeyMaterial(value: unknown): ProvingKeyMaterialDTO {
  if (!value || typeof value !== 'object') throw connectorError('InvalidRequest', 'Proving key material is required');
  const material = value as Partial<ProvingKeyMaterialDTO>;
  return {
    zkir: assertBytes(material.zkir, 'ZKIR'),
    proverKey: assertBytes(material.proverKey, 'Prover key'),
    verifierKey: assertBytes(material.verifierKey, 'Verifier key'),
  };
}

function payFeesOption(options: unknown): boolean {
  const value = (options as { payFees?: unknown } | null | undefined)?.payFees;
  if (value !== undefined && typeof value !== 'boolean') throw connectorError('InvalidRequest', 'payFees must be a boolean');
  return value !== false;
}

function outputDtos(outputs: DesiredOutput[]): TransferRequestDTO[] {
  return outputs.map((out) => {
    if (out.kind !== 'shielded' && out.kind !== 'unshielded') {
      throw connectorError('InvalidRequest', `Unknown output kind: ${String(out.kind)}`);
    }
    return { type: out.kind, tokenId: out.type, amount: String(out.value), to: out.recipient };
  });
}

const toWsUrl = (url: string) => url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

async function balances(name: string, network: string, session: Session) {
  const json = await call('os/balancesGet', { seedHex: session.unlocked.seedHex, walletName: name, network: networkConfig(network) });
  return deserializeBalances(json);
}

async function balance(origin: string, sealed: boolean, params: unknown[]) {
  const { session, name, network } = requireConnected(origin);
  const txHex = assertTxHex(String(params[0] ?? ''));
  const payFees = payFeesOption(params[1]);
  const config = networkConfig(network);
  // An unreadable transaction still gets an approval, which says the amounts are unknown.
  let summary: TxSummaryDTO | null = null;
  try {
    summary = await call('os/txSummary', { network: config, txHex, sealed });
    if (!payFees) summary = { ...summary, spends: summary.spends.filter((entry) => entry.kind !== 'dust') };
  } catch {
    summary = null;
  }
  await approve('balance', origin, { sealed, payFees, summary }, 'User rejected the transaction');
  const result = await call('os/balanceTransaction', {
    seedHex: session.unlocked.seedHex,
    walletName: name,
    network: config,
    txHex,
    sealed,
    payFees,
  });
  return { tx: result.txHex };
}

// --- Dispatch ------------------------------------------------------------------------------

async function dispatch(origin: string, method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case 'connect': {
      const networkId = String(params[0] ?? '');
      const { network } = requireSession();
      if (networkId !== network) {
        throw connectorError('InvalidRequest', `Wallet is connected to "${network}", not "${networkId}"`);
      }
      if (!isAllowed(origin, network)) {
        await approve('connect', origin, { networkId }, 'User rejected the connection request');
        saveGrants({ ...loadGrants(), [origin]: { networkId, grantedAt: Date.now() } });
      }
      return true;
    }

    case 'hintUsage': {
      const { network } = requireSession();
      if (!isAllowed(origin, network)) await dispatch(origin, 'connect', [network]);
      return undefined;
    }

    case 'getConnectionStatus': {
      const current = active && sessions.get(active.name) ? active : null;
      const status: ConnectionStatus =
        current && isAllowed(origin, current.network)
          ? { status: 'connected', networkId: current.network }
          : { status: 'disconnected' };
      return status;
    }

    case 'getConfiguration': {
      const { network } = requireConnected(origin);
      const config = networkConfig(network);
      // The in-app prover is private to Moth, so DApps are not pointed at it.
      const configuration: Configuration = {
        indexerUri: config.indexerUrl,
        indexerWsUri: toWsUrl(config.indexerUrl) + '/ws',
        substrateNodeUri: config.nodeUrl,
        networkId: config.id,
      };
      return configuration;
    }

    case 'getProvingProvider':
      requireConnected(origin);
      return true;

    case 'provingProviderCheck':
    case 'provingProviderProve': {
      const { network } = requireConnected(origin);
      const serializedPreimage = assertBytes(params[0], 'Serialized preimage');
      const keyLocation = params[1];
      if (typeof keyLocation !== 'string' || keyLocation === '') {
        throw connectorError('InvalidRequest', 'Circuit key location must be a non-empty string');
      }
      const keyMaterial = assertKeyMaterial(params[2]);
      const config = networkConfig(network);
      if (method === 'provingProviderCheck') {
        const json = await call('os/provingProviderCheck', {
          network: config,
          payloadJson: encodeBigintJson({ serializedPreimage, keyLocation, keyMaterial }),
        });
        return decodeBigintJson<(bigint | undefined)[]>(json);
      }
      const overwriteBindingInput = params[3];
      if (overwriteBindingInput !== undefined && typeof overwriteBindingInput !== 'bigint') {
        throw connectorError('InvalidRequest', 'overwriteBindingInput must be a bigint');
      }
      const json = await call('os/provingProviderProve', {
        network: config,
        payloadJson: encodeBigintJson({ serializedPreimage, keyLocation, keyMaterial, overwriteBindingInput }),
      });
      return decodeBigintJson<Uint8Array>(json);
    }

    case 'getShieldedBalances': {
      const { session, name, network } = requireConnected(origin);
      return (await balances(name, network, session)).shielded;
    }

    case 'getUnshieldedBalances': {
      const { session, name, network } = requireConnected(origin);
      return (await balances(name, network, session)).unshielded;
    }

    case 'getDustBalance': {
      const { session, name, network } = requireConnected(origin);
      const b = await balances(name, network, session);
      return { cap: b.dustGeneration?.limit ?? 0n, balance: b.dust };
    }

    case 'getShieldedAddresses': {
      const { session, network } = requireConnected(origin);
      return {
        shieldedAddress: addressOn(session.unlocked.addresses.zswap, network),
        shieldedCoinPublicKey: session.unlocked.shieldedCoinPublicKey,
        shieldedEncryptionPublicKey: session.unlocked.shieldedEncryptionPublicKey,
      };
    }

    case 'getUnshieldedAddress': {
      const { session, network } = requireConnected(origin);
      return { unshieldedAddress: addressOn(session.unlocked.addresses.nightExternal, network) };
    }

    case 'getDustAddress': {
      const { session, network } = requireConnected(origin);
      return { dustAddress: addressOn(session.unlocked.addresses.dust, network) };
    }

    case 'getTxHistory': {
      const { session, name, network } = requireConnected(origin);
      const pageNumber = Number(params[0]);
      const pageSize = Number(params[1]);
      if (!Number.isInteger(pageNumber) || pageNumber < 0 || !Number.isInteger(pageSize) || pageSize <= 0) {
        throw connectorError('InvalidRequest', 'getTxHistory requires pageNumber (>= 0) and pageSize (>= 1)');
      }
      return call('os/txHistoryGet', {
        seedHex: session.unlocked.seedHex,
        walletName: name,
        network: networkConfig(network),
        pageNumber,
        pageSize,
      });
    }

    case 'signData': {
      const { session, network } = requireConnected(origin);
      const data = params[0];
      const options = (params[1] ?? {}) as { encoding?: unknown; keyType?: unknown };
      if (typeof data !== 'string') throw connectorError('InvalidRequest', 'signData requires the data as a string');
      if (options.keyType !== 'unshielded') {
        throw connectorError('InvalidRequest', 'signData supports only keyType "unshielded"');
      }
      const encoding = options.encoding;
      if (encoding !== 'hex' && encoding !== 'base64' && encoding !== 'text') {
        throw connectorError('InvalidRequest', 'signData encoding must be "hex", "base64", or "text"');
      }
      await approve('signData', origin, { encoding, message: data }, 'User rejected the signing request');
      try {
        return await call('os/signData', { seedHex: session.unlocked.seedHex, network: networkConfig(network), data, encoding });
      } catch (err) {
        throw connectorError('InvalidRequest', (err as Error).message ?? 'Failed to sign data');
      }
    }

    case 'deriveAppSecret': {
      const { session } = requireConnected(origin);
      const domain = params[0];
      if (typeof domain !== 'string' || domain.length === 0 || domain.length > 128 || /[^\x20-\x7e]/.test(domain)) {
        throw connectorError('InvalidRequest', 'deriveAppSecret requires a short printable-ASCII domain string (1–128 chars)');
      }
      await approve('deriveAppSecret', origin, { domain }, 'User rejected the derivation request');
      return call('os/deriveAppSecret', { seedHex: session.unlocked.seedHex, origin, domain });
    }

    case 'balanceSealedTransaction':
      return balance(origin, true, params);

    case 'balanceUnsealedTransaction':
      return balance(origin, false, params);

    case 'makeIntent': {
      const { session, name, network } = requireConnected(origin);
      const inputs = (params[0] ?? []) as DesiredInput[];
      const outputs = (params[1] ?? []) as DesiredOutput[];
      const payFees = payFeesOption(params[2]);
      if (!Array.isArray(inputs) || !Array.isArray(outputs) || inputs.length + outputs.length === 0) {
        throw connectorError('InvalidRequest', 'makeIntent requires at least one input or output');
      }
      const inputDtos: SwapInputDTO[] = inputs.map((input) => {
        if (input.kind !== 'shielded' && input.kind !== 'unshielded') {
          throw connectorError('InvalidRequest', `Unknown input kind: ${String(input.kind)}`);
        }
        return { type: input.kind, tokenId: input.type, amount: String(input.value) };
      });
      const requests = outputDtos(outputs);
      await approve(
        'transfer',
        origin,
        {
          inputs: inputs.map((input) => ({ kind: input.kind, type: input.type, value: input.value.toString() })),
          outputs: outputs.map((out) => ({ ...out, value: out.value.toString() })),
          payFees,
        },
        'User rejected the transaction',
      );
      const { txHex } = await call('os/makeIntent', {
        seedHex: session.unlocked.seedHex,
        walletName: name,
        network: networkConfig(network),
        inputs: inputDtos,
        outputs: requests,
        payFees,
      });
      return { tx: txHex };
    }

    case 'makeTransfer': {
      const { session, name, network } = requireConnected(origin);
      const outputs = (params[0] ?? []) as DesiredOutput[];
      const payFees = payFeesOption(params[1]);
      if (!Array.isArray(outputs) || outputs.length === 0) {
        throw connectorError('InvalidRequest', 'makeTransfer requires at least one desired output');
      }
      const requests = outputDtos(outputs);
      await approve(
        'transfer',
        origin,
        { outputs: outputs.map((out) => ({ ...out, value: out.value.toString() })), payFees },
        'User rejected the transfer',
      );
      const { txHex } = await call('os/transferBuild', {
        seedHex: session.unlocked.seedHex,
        walletName: name,
        network: networkConfig(network),
        requests,
        payFees,
      });
      return { tx: txHex };
    }

    case 'submitTransaction': {
      const { session, name, network } = requireConnected(origin);
      const txHex = assertTxHex(String(params[0] ?? ''));
      // Submitting is irreversible, so it is approved like the build that produced it.
      await approve('submit', origin, { bytes: txHex.length / 2 }, 'User rejected the submission');
      await call('os/transferSubmit', { seedHex: session.unlocked.seedHex, walletName: name, network: networkConfig(network), txHex });
      return undefined;
    }

    default:
      throw connectorError('InvalidRequest', `Unknown method: ${String(method)}`);
  }
}

function toWireError(err: unknown): { code: ErrorCode; reason: string } {
  const api = err as Partial<APIError>;
  if (api?.type === 'DAppConnectorAPIError' && api.code) return { code: api.code, reason: String(api.reason ?? api.message) };
  const detail = describeErrorFields(err);
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'InternalError', reason: detail ? `${message} (${detail})` : message };
}

// --- API for Swift -------------------------------------------------------------------------

export const connector = {
  /** Sets the wallet DApps talk to; null when locked. */
  setActive(name: string | null, network?: string) {
    active = name && network ? { name, network } : null;
    if (!active) connector.rejectAll();
  },

  /** Handles one call from a DApp; never throws, so the error reaches the page intact. */
  async request(origin: string, method: string, paramsJson: string): Promise<string> {
    try {
      const params = decodeBigintJson<unknown[]>(paramsJson);
      const result = await dispatch(origin, method, Array.isArray(params) ? params : []);
      return JSON.stringify({ ok: true, resultJson: encodeBigintJson(result) });
    } catch (err) {
      return JSON.stringify({ ok: false, error: toWireError(err) });
    }
  },

  resolve(id: number, approved: boolean) {
    approvals.get(id)?.(approved);
    approvals.delete(id);
  },

  rejectAll() {
    for (const resolve of approvals.values()) resolve(false);
    approvals.clear();
  },

  grants: () => Object.entries(loadGrants()).map(([origin, g]) => ({ origin, networkId: g.networkId, grantedAt: g.grantedAt })),

  revoke(origin: string) {
    const grants = loadGrants();
    delete grants[origin];
    saveGrants(grants);
  },
};

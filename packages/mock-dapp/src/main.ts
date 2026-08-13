import type {
  ConnectedAPI,
  DesiredInput,
  DesiredOutput,
  InitialAPI,
  KeyMaterialProvider,
  SignDataOptions,
  WalletConnectedAPI,
} from '@midnight-ntwrk/dapp-connector-api';
import './styles.css';

type ProviderEntry = {
  id: string;
  api: InitialAPI;
};

type RequestStatus = 'pending' | 'success' | 'error';

type RequestRecord = {
  id: number;
  method: string;
  startedAt: Date;
  durationMs?: number;
  status: RequestStatus;
  output?: unknown;
};

type MidnightWindow = Window & {
  midnight?: Record<string, unknown>;
};

const elements = {
  providerPill: byId<HTMLDivElement>('provider-pill'),
  providerState: byId<HTMLSpanElement>('provider-state'),
  refreshProviders: byId<HTMLButtonElement>('refresh-providers'),
  walletSelect: byId<HTMLSelectElement>('wallet-select'),
  networkId: byId<HTMLInputElement>('network-id'),
  connect: byId<HTMLButtonElement>('connect'),
  resetConnection: byId<HTMLButtonElement>('reset-connection'),
  providerMetadata: byId<HTMLDivElement>('provider-metadata'),
  walletIcon: byId<HTMLImageElement>('wallet-icon'),
  walletName: byId<HTMLElement>('wallet-name'),
  walletRdns: byId<HTMLElement>('wallet-rdns'),
  walletVersion: byId<HTMLElement>('wallet-version'),
  operationStatus: byId<HTMLParagraphElement>('operation-status'),
  requestLog: byId<HTMLDivElement>('request-log'),
  emptyLog: byId<HTMLDivElement>('empty-log'),
  copyLog: byId<HTMLButtonElement>('copy-log'),
  clearLog: byId<HTMLButtonElement>('clear-log'),
  transactionHex: byId<HTMLTextAreaElement>('transaction-hex'),
  transactionConnectionHelp: byId<HTMLParagraphElement>('transaction-connection-help'),
};

let providers: ProviderEntry[] = [];
let connectedApi: ConnectedAPI | undefined;
let connectedProviderId: string | undefined;
let connectedNetworkId: string | undefined;
let nextRequestId = 1;
const requestRecords: RequestRecord[] = [];

function byId<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing required element #${id}`);
  return value as T;
}

function isInitialApi(value: unknown): value is InitialAPI {
  if (!value || typeof value !== 'object') return false;
  const api = value as Partial<InitialAPI>;
  return (
    typeof api.rdns === 'string' &&
    typeof api.name === 'string' &&
    typeof api.icon === 'string' &&
    typeof api.apiVersion === 'string' &&
    typeof api.connect === 'function'
  );
}

function discoverProviders(): ProviderEntry[] {
  const injected = (window as MidnightWindow).midnight ?? {};
  return Object.entries(injected)
    .filter((entry): entry is [string, InitialAPI] => isInitialApi(entry[1]))
    .map(([id, api]) => ({ id, api }));
}

function selectedProvider(): ProviderEntry | undefined {
  return providers.find(({ id }) => id === elements.walletSelect.value);
}

function refreshProviders(): boolean {
  const previousSelection = elements.walletSelect.value;
  providers = discoverProviders();
  elements.walletSelect.replaceChildren();

  if (providers.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No provider detected';
    elements.walletSelect.append(option);
    elements.walletSelect.disabled = true;
    elements.connect.disabled = true;
    connectedApi = undefined;
    connectedProviderId = undefined;
    connectedNetworkId = undefined;
    renderProvider();
    return false;
  }

  for (const provider of providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = `${provider.api.name} (${provider.id})`;
    elements.walletSelect.append(option);
  }

  const fallback = providers.find(({ id }) => id === 'moth') ?? providers[0];
  const nextSelection = providers.some(({ id }) => id === previousSelection)
    ? previousSelection
    : fallback?.id ?? '';
  elements.walletSelect.value = nextSelection;
  elements.walletSelect.disabled = false;
  elements.connect.disabled = false;

  if (connectedProviderId && connectedProviderId !== nextSelection) {
    connectedApi = undefined;
    connectedProviderId = undefined;
    connectedNetworkId = undefined;
  }
  renderProvider();
  return true;
}

function renderProvider(): void {
  const provider = selectedProvider();
  const isConnected = Boolean(connectedApi && connectedProviderId === provider?.id);

  if (!provider) {
    elements.providerPill.dataset.state = 'waiting';
    elements.providerState.textContent = 'No provider detected';
    elements.providerMetadata.hidden = true;
  } else {
    elements.providerPill.dataset.state = isConnected ? 'connected' : 'ready';
    elements.providerState.textContent = isConnected ? `Connected to ${provider.api.name}` : `${provider.api.name} detected`;
    elements.providerMetadata.hidden = false;
    elements.walletName.textContent = provider.api.name;
    elements.walletRdns.textContent = provider.api.rdns;
    elements.walletVersion.textContent = provider.api.apiVersion;
    elements.walletIcon.hidden = provider.api.icon.length === 0;
    elements.walletIcon.src = provider.api.icon;
    elements.walletIcon.alt = `${provider.api.name} icon`;
  }

  elements.connect.disabled = !provider;
  elements.resetConnection.disabled = !isConnected;
  elements.transactionConnectionHelp.hidden = isConnected;
  for (const control of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-requires-connection]'))) {
    control.disabled = !isConnected;
  }
}

function requireConnected(): ConnectedAPI {
  if (!connectedApi) {
    throw new Error('Connect to a wallet before calling connected API methods.');
  }
  return connectedApi;
}

function inputValue(id: string): string {
  return byId<HTMLInputElement | HTMLTextAreaElement>(id).value.trim();
}

function requiredInput(id: string, label: string): string {
  const value = inputValue(id);
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function checkboxValue(id: string): boolean {
  return byId<HTMLInputElement>(id).checked;
}

function bigintInput(id: string, label: string): bigint {
  const value = requiredInput(id, label);
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${label} must be an integer.`);
  }
}

function intentIdInput(): number | 'random' {
  const value = requiredInput('intent-id', 'Intent ID');
  if (value === 'random') return value;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Intent ID must be "random" or a safe integer.');
  return parsed;
}

function normalizeError(error: unknown): Record<string, unknown> {
  if (error && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of ['name', 'type', 'code', 'reason', 'message']) {
      if (candidate[key] !== undefined) normalized[key] = candidate[key];
    }
    if (Object.keys(normalized).length > 0) return normalized;
  }
  return { message: String(error) };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Uint8Array) {
    return {
      type: 'Uint8Array',
      hex: Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  }
  if (value instanceof Error) return normalizeError(value);
  return value;
}

function prettyJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value, jsonReplacer, 2) ?? String(value);
}

function setOperationStatus(message: string, state: 'neutral' | 'success' | 'error' = 'neutral'): void {
  elements.operationStatus.textContent = message;
  elements.operationStatus.dataset.state = state;
}

function renderLog(): void {
  elements.emptyLog.hidden = requestRecords.length > 0;
  elements.requestLog.replaceChildren();

  for (const record of requestRecords) {
    const item = document.createElement('details');
    item.className = `request-record request-${record.status}`;
    item.open = record.id === requestRecords[0]?.id;

    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.className = 'request-name';
    title.textContent = record.method;

    const meta = document.createElement('span');
    meta.className = 'request-meta';
    const duration = record.durationMs === undefined ? 'pending' : `${record.durationMs} ms`;
    meta.textContent = `${record.startedAt.toLocaleTimeString()} · ${duration}`;
    summary.append(title, meta);

    const output = document.createElement('pre');
    output.textContent = record.status === 'pending' ? 'Waiting for wallet response…' : prettyJson(record.output);
    item.append(summary, output);
    elements.requestLog.append(item);
  }
}

async function runRequest<T>(
  method: string,
  trigger: HTMLElement,
  request: () => Promise<T>,
  options: {
    pendingMessage?: string;
    successMessage?: (result: T, durationMs: number) => string;
  } = {},
): Promise<T | undefined> {
  const record: RequestRecord = {
    id: nextRequestId++,
    method,
    startedAt: new Date(),
    status: 'pending',
  };
  requestRecords.unshift(record);
  renderLog();
  trigger.setAttribute('aria-busy', 'true');
  const wasDisabled = trigger instanceof HTMLButtonElement ? trigger.disabled : undefined;
  if (trigger instanceof HTMLButtonElement) trigger.disabled = true;
  setOperationStatus(options.pendingMessage ?? `${method} is waiting for the wallet…`);

  const started = performance.now();
  try {
    const result = await request();
    record.status = 'success';
    record.output = result;
    record.durationMs = Math.round(performance.now() - started);
    setOperationStatus(
      options.successMessage?.(result, record.durationMs) ?? `${method} completed in ${record.durationMs} ms.`,
      'success',
    );
    return result;
  } catch (error) {
    record.status = 'error';
    record.output = normalizeError(error);
    record.durationMs = Math.round(performance.now() - started);
    const details = record.output as Record<string, unknown>;
    const reason = details.reason ?? details.message ?? 'Unknown error';
    const code = details.code ? `${String(details.code)}: ` : '';
    setOperationStatus(`${method} failed — ${code}${String(reason)}`, 'error');
    return undefined;
  } finally {
    trigger.removeAttribute('aria-busy');
    if (trigger instanceof HTMLButtonElement && wasDisabled !== undefined) trigger.disabled = wasDisabled;
    renderProvider();
    renderLog();
  }
}

function submitButton(event: SubmitEvent): HTMLElement {
  return event.submitter instanceof HTMLElement ? event.submitter : (event.currentTarget as HTMLElement);
}

function putTransaction(tx: string): void {
  elements.transactionHex.value = tx;
  elements.transactionHex.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

elements.walletIcon.addEventListener('error', () => {
  elements.walletIcon.hidden = true;
});

elements.refreshProviders.addEventListener('click', () => {
  const found = refreshProviders();
  setOperationStatus(found ? `Found ${providers.length} injected provider${providers.length === 1 ? '' : 's'}.` : 'No provider found.');
});

elements.walletSelect.addEventListener('change', () => {
  connectedApi = undefined;
  connectedProviderId = undefined;
  connectedNetworkId = undefined;
  renderProvider();
  setOperationStatus('Provider changed. Connect to create a new local API session.');
});

elements.connect.addEventListener('click', () => {
  const provider = selectedProvider();
  void runRequest('connect', elements.connect, async () => {
    if (!provider) throw new Error('No injected wallet provider is available.');
    const networkId = requiredInput('network-id', 'Requested network');
    const api = await provider.api.connect(networkId);
    connectedApi = api;
    connectedProviderId = provider.id;
    connectedNetworkId = networkId;
    return {
      walletId: provider.id,
      name: provider.api.name,
      rdns: provider.api.rdns,
      apiVersion: provider.api.apiVersion,
      networkId,
      methods: Object.keys(api).sort(),
    };
  });
});

elements.resetConnection.addEventListener('click', () => {
  connectedApi = undefined;
  connectedProviderId = undefined;
  connectedNetworkId = undefined;
  renderProvider();
  setOperationStatus('Cleared the dapp’s local ConnectedAPI reference. Wallet permissions were not changed.');
});

const statusButton = byId<HTMLButtonElement>('get-status');
statusButton.addEventListener('click', () => {
  void runRequest('getConnectionStatus', statusButton, () => requireConnected().getConnectionStatus());
});

const configurationButton = byId<HTMLButtonElement>('get-configuration');
configurationButton.addEventListener('click', () => {
  void runRequest('getConfiguration', configurationButton, () => requireConnected().getConfiguration());
});

const balancesButton = byId<HTMLButtonElement>('get-balances');
balancesButton.addEventListener('click', () => {
  void runRequest('getShieldedBalances + getUnshieldedBalances + getDustBalance', balancesButton, async () => {
    const api = requireConnected();
    const [shielded, unshielded, dust] = await Promise.all([
      api.getShieldedBalances(),
      api.getUnshieldedBalances(),
      api.getDustBalance(),
    ]);
    return { shielded, unshielded, dust };
  });
});

const addressesButton = byId<HTMLButtonElement>('get-addresses');
addressesButton.addEventListener('click', () => {
  void runRequest('getShieldedAddresses + getUnshieldedAddress + getDustAddress', addressesButton, async () => {
    const api = requireConnected();
    const [shielded, unshielded, dust] = await Promise.all([
      api.getShieldedAddresses(),
      api.getUnshieldedAddress(),
      api.getDustAddress(),
    ]);
    return { shielded, unshielded, dust };
  });
});

byId<HTMLFormElement>('history-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitEvent = event as SubmitEvent;
  void runRequest('getTxHistory', submitButton(submitEvent), () => {
    const page = Number(inputValue('history-page'));
    const size = Number(inputValue('history-size'));
    return requireConnected().getTxHistory(page, size);
  });
});

byId<HTMLFormElement>('hint-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitEvent = event as SubmitEvent;
  void runRequest('hintUsage', submitButton(submitEvent), async () => {
    const selected = byId<HTMLSelectElement>('hint-methods').selectedOptions;
    const methods = Array.from(selected, (option) => option.value as keyof WalletConnectedAPI);
    await requireConnected().hintUsage(methods);
    return { methods };
  });
});

byId<HTMLFormElement>('sign-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitEvent = event as SubmitEvent;
  void runRequest('signData', submitButton(submitEvent), () => {
    const encoding = byId<HTMLSelectElement>('sign-encoding').value as SignDataOptions['encoding'];
    return requireConnected().signData(inputValue('sign-data'), { encoding, keyType: 'unshielded' });
  });
});

// deriveAppSecret is a wallet EXTENSION method — not in the typed
// dapp-connector-api — so real consumers (and this harness) reach it via a
// cast. The returned { secret } renders in the request log below; the same
// (seed, origin, domain) always yields the same value.
type AppSecretApi = { deriveAppSecret(domain: string): Promise<{ secret: string }> };
byId<HTMLFormElement>('derive-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitEvent = event as SubmitEvent;
  void runRequest('deriveAppSecret', submitButton(submitEvent), () => {
    const domain = requiredInput('derive-domain', 'Domain label');
    return (requireConnected() as unknown as AppSecretApi).deriveAppSecret(domain);
  });
});

byId<HTMLFormElement>('transfer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitEvent = event as SubmitEvent;
  void runRequest('makeTransfer', submitButton(submitEvent), async () => {
    const output: DesiredOutput = {
      kind: byId<HTMLSelectElement>('transfer-kind').value as DesiredOutput['kind'],
      type: requiredInput('transfer-token', 'Token type'),
      value: bigintInput('transfer-value', 'Raw amount'),
      recipient: requiredInput('transfer-recipient', 'Recipient'),
    };
    const result = await requireConnected().makeTransfer([output], { payFees: checkboxValue('transfer-fees') });
    putTransaction(result.tx);
    return result;
  });
});

byId<HTMLFormElement>('intent-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitEvent = event as SubmitEvent;
  void runRequest('makeIntent', submitButton(submitEvent), async () => {
    const input: DesiredInput = {
      kind: byId<HTMLSelectElement>('intent-input-kind').value as DesiredInput['kind'],
      type: requiredInput('intent-input-token', 'Input token type'),
      value: bigintInput('intent-input-value', 'Input raw amount'),
    };
    const output: DesiredOutput = {
      kind: byId<HTMLSelectElement>('intent-output-kind').value as DesiredOutput['kind'],
      type: requiredInput('intent-output-token', 'Output token type'),
      value: bigintInput('intent-output-value', 'Output raw amount'),
      recipient: requiredInput('intent-recipient', 'Intent recipient'),
    };
    const result = await requireConnected().makeIntent([input], [output], {
      intentId: intentIdInput(),
      payFees: checkboxValue('intent-fees'),
    });
    putTransaction(result.tx);
    return result;
  });
});

const balanceButton = byId<HTMLButtonElement>('balance-transaction');

const generateNightTransferButton = byId<HTMLButtonElement>('generate-night-transfer');
generateNightTransferButton.addEventListener('click', () => {
  void runRequest(
    'generateUnbalancedNightTransfer (local)',
    generateNightTransferButton,
    async () => {
      const fixtureNetwork = 'preprod';
      if (connectedApi && connectedNetworkId !== fixtureNetwork) {
        throw new Error(
          `The fixture targets ${fixtureNetwork}; reset the local session and reconnect to ${fixtureNetwork} first.`,
        );
      }
      if (!connectedApi) byId<HTMLInputElement>('network-id').value = fixtureNetwork;

      const { createUnbalancedNightTransfer } = await import('./night-transfer-fixture');
      const fixture = await createUnbalancedNightTransfer();
      byId<HTMLSelectElement>('balance-type').value = fixture.bindingStage;
      putTransaction(fixture.tx);
      return fixture;
    },
    {
      pendingMessage: 'Loading Ledger v8 and generating the transaction locally…',
      successMessage: (_fixture, durationMs) =>
        connectedApi
          ? `Generated the unbalanced transaction in ${durationMs} ms. Click Balance next.`
          : `Generated the unbalanced transaction in ${durationMs} ms. Connect to preprod to enable Balance and Submit.`,
    },
  );
});

balanceButton.addEventListener('click', () => {
  const sealed = byId<HTMLSelectElement>('balance-type').value === 'sealed';
  const method = sealed ? 'balanceSealedTransaction' : 'balanceUnsealedTransaction';
  void runRequest(method, balanceButton, async () => {
    const api = requireConnected();
    const tx = requiredInput('transaction-hex', 'Serialized transaction');
    const options = { payFees: checkboxValue('balance-fees') };
    const result = sealed
      ? await api.balanceSealedTransaction(tx, options)
      : await api.balanceUnsealedTransaction(tx, options);
    putTransaction(result.tx);
    return { bindingStage: sealed ? 'sealed' : 'unsealed', ...result };
  });
});

byId<HTMLFormElement>('transaction-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const submitEvent = event as SubmitEvent;
  void runRequest('submitTransaction', submitButton(submitEvent), async () => {
    const tx = requiredInput('transaction-hex', 'Serialized transaction');
    await requireConnected().submitTransaction(tx);
    return { submitted: true, transactionBytes: tx.length / 2 };
  });
});

const provingProviderButton = byId<HTMLButtonElement>('get-proving-provider');
provingProviderButton.addEventListener('click', () => {
  void runRequest('getProvingProvider', provingProviderButton, async () => {
    const emptyBytes = async (): Promise<Uint8Array> => new Uint8Array();
    const keys: KeyMaterialProvider = {
      getZKIR: emptyBytes,
      getProverKey: emptyBytes,
      getVerifierKey: emptyBytes,
    };
    const proving = await requireConnected().getProvingProvider(keys);
    return {
      check: typeof proving.check,
      prove: typeof proving.prove,
    };
  });
});

elements.clearLog.addEventListener('click', () => {
  requestRecords.length = 0;
  renderLog();
  setOperationStatus('Request log cleared.');
});

elements.copyLog.addEventListener('click', () => {
  const exportRecords = requestRecords.map(({ startedAt, ...record }) => ({
    ...record,
    startedAt: startedAt.toISOString(),
  }));
  void navigator.clipboard
    .writeText(prettyJson(exportRecords))
    .then(() => setOperationStatus(`Copied ${requestRecords.length} request record${requestRecords.length === 1 ? '' : 's'}.`, 'success'))
    .catch((error) => setOperationStatus(`Could not copy log: ${String(error)}`, 'error'));
});

const foundImmediately = refreshProviders();
renderLog();
if (foundImmediately) {
  setOperationStatus('Provider detected. Choose a network and connect.');
} else {
  let attempts = 0;
  const discoveryTimer = window.setInterval(() => {
    attempts += 1;
    if (refreshProviders()) {
      window.clearInterval(discoveryTimer);
      setOperationStatus('Provider detected. Choose a network and connect.');
    } else if (attempts >= 20) {
      window.clearInterval(discoveryTimer);
      setOperationStatus('No provider detected. Install or enable a compatible wallet, then refresh.');
    }
  }, 250);
}

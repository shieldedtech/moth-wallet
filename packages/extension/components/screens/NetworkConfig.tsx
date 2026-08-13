// Named Midnight network selection shared by setup (new account) and
// Settings (the active account). Endpoint URLs remain editable overrides, but
// there is intentionally no separate "Custom" network choice.

import { useEffect, useState } from 'react';
import { Check, Cpu, Globe, RefreshCw, Server, TriangleAlert } from 'lucide-react';
import {
  DEFAULT_NETWORKS,
  SUPPORTED_NETWORKS,
  proverConfigsEqual,
  resolveProverConfig,
  serverProver,
  type ProverConfig,
} from '@shieldedtech/moth-wallet/types/network';
import { t, type MessageKey } from '../../lib/i18n';
import { sendMessage, type NetworkEndpoints } from '../../lib/messaging/protocol';
import { Button } from '../ui/button';
import { DialogShell } from '../ui/dialog';
import { Input } from '../ui/input';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { NoteCard } from '../moth/note-card';

export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

const NETWORK_LABELS: Record<SupportedNetwork, string> = {
  mainnet: 'Mainnet',
  devnet: 'Devnet',
  preview: 'Preview',
  preprod: 'Preprod',
  qanet: 'QA net',
  local: 'Local',
};

const NETWORK_DESCRIPTIONS: Record<SupportedNetwork, MessageKey> = {
  mainnet: 'network_descMainnet',
  devnet: 'network_descDevnet',
  preview: 'network_descPreview',
  preprod: 'network_descPreprod',
  qanet: 'network_descQanet',
  local: 'network_descLocal',
};

const isSupported = (id: string): id is SupportedNetwork =>
  (SUPPORTED_NETWORKS as readonly string[]).includes(id);

/**
 * Networks carrying real value, hidden unless the user opts in.
 *
 * This wallet is unaudited, unsupported and explicitly for development — the
 * package description says so — so mainnet is not something to land on by
 * default or reach by mistake. Developer mode is the opt-in, and selecting it
 * still requires acknowledging what it means.
 *
 * A wallet ALREADY on such a network always keeps seeing it, whatever the
 * setting: hiding the network an account lives on would strand it with no way
 * back.
 */
const VALUE_BEARING: readonly string[] = ['mainnet'];

export const isValueBearing = (id: string): boolean => VALUE_BEARING.includes(id);

/** Which networks to offer: the gated ones only with developer mode on, plus
 *  whichever network the wallet is currently using. */
export function selectableNetworks(developerMode: boolean, current?: string): readonly SupportedNetwork[] {
  return SUPPORTED_NETWORKS.filter(
    (id) => !isValueBearing(id) || developerMode || id === current,
  );
}

const presetFor = (network: SupportedNetwork): NetworkEndpoints => {
  const preset = DEFAULT_NETWORKS[network]!;
  return {
    nodeUrl: preset.nodeUrl,
    indexerUrl: preset.indexerUrl,
    prover: resolveProverConfig(preset),
  };
};

const normalized = (endpoints: NetworkEndpoints): NetworkEndpoints => {
  const name = endpoints.nodeAuthHeader?.name.trim() ?? '';
  const value = endpoints.nodeAuthHeader?.value.trim() ?? '';
  return {
    nodeUrl: endpoints.nodeUrl.trim(),
    indexerUrl: endpoints.indexerUrl.trim(),
    prover: endpoints.prover.type === 'server'
      ? serverProver(endpoints.prover.url.trim())
      : endpoints.prover,
    // A header with no value is no header, so it must normalise away — otherwise
    // typing a name and deleting it again reads as an unsaved change for ever.
    ...(name !== '' && value !== '' ? { nodeAuthHeader: { name, value } } : {}),
  };
};

const endpointsEqual = (left: NetworkEndpoints, right: NetworkEndpoints): boolean => {
  const a = normalized(left);
  const b = normalized(right);
  return (
    a.nodeUrl === b.nodeUrl &&
    a.indexerUrl === b.indexerUrl &&
    proverConfigsEqual(a.prover, b.prover) &&
    a.nodeAuthHeader?.name === b.nodeAuthHeader?.name &&
    a.nodeAuthHeader?.value === b.nodeAuthHeader?.value
  );
};

const overridesFor = (network: SupportedNetwork, endpoints: NetworkEndpoints): NetworkEndpoints | null =>
  endpointsEqual(endpoints, presetFor(network)) ? null : normalized(endpoints);

/** Friendly name for a stored network id (falls back to the raw id). */
export function networkLabel(id: string): string {
  return isSupported(id) ? NETWORK_LABELS[id] : id;
}

export interface NetworkConfigState {
  network: SupportedNetwork;
  current: SupportedNetwork;
  urls: NetworkEndpoints;
  currentUrls: NetworkEndpoints;
  ready: boolean;
  changed: boolean;
  networkChanged: boolean;
  indexerChanged: boolean;
  requiresResyncConfirmation: boolean;
  usesOverrides: boolean;
  valid: boolean;
  developerMode: boolean;
  available: readonly SupportedNetwork[];
  needsValueWarning: boolean;
  pick: (next: SupportedNetwork) => void;
  edit: (field: 'nodeUrl' | 'indexerUrl') => (value: string) => void;
  editAuthHeader: (field: 'name' | 'value') => (value: string) => void;
  setProverType: (type: ProverConfig['type']) => void;
  editProverUrl: (value: string) => void;
  resetEndpoints: () => void;
  /** Save the selection as the default used by setup/new accounts. */
  save: () => Promise<void>;
}

export function useNetworkConfig(fallback: SupportedNetwork = 'mainnet'): NetworkConfigState {
  const fallbackUrls = presetFor(fallback);
  const [current, setCurrent] = useState<SupportedNetwork>(fallback);
  const [network, setNetwork] = useState<SupportedNetwork>(fallback);
  const [currentUrls, setCurrentUrls] = useState<NetworkEndpoints>(fallbackUrls);
  const [urls, setUrls] = useState<NetworkEndpoints>(fallbackUrls);
  const [ready, setReady] = useState(false);

  const [developerMode, setDeveloperMode] = useState(false);

  useEffect(() => {
    void sendMessage('settingsGet', undefined).then((settings) => {
      const named = isSupported(settings.network) ? settings.network : fallback;
      const loadedUrls = settings.customEndpoints ?? presetFor(named);
      setCurrent(named);
      setNetwork(named);
      setCurrentUrls(loadedUrls);
      setUrls(loadedUrls);
      setDeveloperMode(settings.developerMode);
      setReady(true);
    });
  }, [fallback]);

  const pick = (next: SupportedNetwork) => {
    setNetwork(next);
    setUrls(next === current ? currentUrls : presetFor(next));
  };

  const edit = (field: 'nodeUrl' | 'indexerUrl') => (value: string) => {
    setUrls((previous) => ({ ...previous, [field]: value }));
  };

  const setProverType = (type: ProverConfig['type']) => {
    setUrls((previous) => {
      if (type === 'wasm') return { ...previous, prover: { type: 'wasm' } };
      if (previous.prover.type === 'server') return previous;
      const preset = presetFor(network).prover;
      return { ...previous, prover: preset.type === 'server' ? preset : serverProver() };
    });
  };

  const editProverUrl = (value: string) => {
    setUrls((previous) => ({ ...previous, prover: serverProver(value) }));
  };

  const editAuthHeader = (field: 'name' | 'value') => (next: string) => {
    setUrls((previous) => {
      const header = {
        name: previous.nodeAuthHeader?.name ?? DEFAULT_AUTH_HEADER_NAME,
        value: previous.nodeAuthHeader?.value ?? '',
        [field]: next,
      };
      // An empty value means "no header" — drop the whole thing rather than
      // storing a blank credential.
      if (header.value.trim() === '') {
        const { nodeAuthHeader: _dropped, ...rest } = previous;
        return field === 'name' && next.trim() !== ''
          ? { ...rest, nodeAuthHeader: { name: next, value: '' } }
          : rest;
      }
      return { ...previous, nodeAuthHeader: header };
    });
  };

  const save = async () => {
    await sendMessage('settingsSet', {
      network,
      customEndpoints: overridesFor(network, urls),
    });
  };

  const networkChanged = ready && network !== current;
  const indexerChanged = ready && normalized(urls).indexerUrl !== normalized(currentUrls).indexerUrl;
  const normalizedUrls = normalized(urls);

  return {
    network,
    current,
    urls,
    currentUrls,
    ready,
    changed: ready && (networkChanged || !endpointsEqual(urls, currentUrls)),
    networkChanged,
    indexerChanged,
    requiresResyncConfirmation: networkChanged || indexerChanged,
    usesOverrides: !endpointsEqual(urls, presetFor(network)),
    valid:
      ready &&
      normalizedUrls.nodeUrl !== '' &&
      normalizedUrls.indexerUrl !== '' &&
      (normalizedUrls.prover.type === 'wasm' || normalizedUrls.prover.url !== ''),
    developerMode,
    available: selectableNetworks(developerMode, current),
    /** True once a value-bearing network is selected but is not yet the saved
     *  one — the moment to ask for acknowledgement rather than after the fact. */
    needsValueWarning: isValueBearing(network) && network !== current,
    pick,
    edit,
    editAuthHeader,
    setProverType,
    editProverUrl,
    resetEndpoints: () => setUrls(presetFor(network)),
    save,
  };
}

/** Accessible named-network list plus editable endpoint overrides. */
export function NetworkFields({ state }: { state: NetworkConfigState }) {
  return (
    <>
      <div role="radiogroup" aria-label={t('network_groupAria')} className="flex flex-col gap-2.5">
        {state.available.map((id) => (
          <NetworkOption key={id} id={id} active={state.network === id} onPick={() => state.pick(id)} />
        ))}
        {!state.developerMode && state.available.length < SUPPORTED_NETWORKS.length && (
          <p className="m-0 px-1 text-[12.5px] text-muted-foreground">{t('network_mainnetHidden')}</p>
        )}
      </div>

      <div className="mt-1 flex flex-col gap-3 rounded-[16px] bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="section-label m-0">{t('network_endpointUrls')}</p>
          {state.usesOverrides && (
            <button
              type="button"
              onClick={state.resetEndpoints}
              className="cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-link hover:underline"
            >
              {t('network_useDefaults')}
            </button>
          )}
        </div>
        <UrlField label={t('network_nodeUrl')} value={state.urls.nodeUrl} onChange={state.edit('nodeUrl')} />
        <UrlField label={t('network_indexerUrl')} value={state.urls.indexerUrl} onChange={state.edit('indexerUrl')} />
        <UrlField
          label={t('network_authHeaderName')}
          value={state.urls.nodeAuthHeader?.name ?? DEFAULT_AUTH_HEADER_NAME}
          onChange={state.editAuthHeader('name')}
        />
        <UrlField
          label={t('network_authHeaderValue')}
          value={state.urls.nodeAuthHeader?.value ?? ''}
          onChange={state.editAuthHeader('value')}
          secret
        />
        <p className="m-0 text-[12px] text-muted-foreground">{t('network_authHeaderHelp')}</p>
      </div>

      <div className="mt-1 flex flex-col gap-3 rounded-[16px] bg-card p-4">
        <p className="section-label m-0">{t('network_proving')}</p>
        <div role="radiogroup" aria-label={t('network_provingMethodAria')} className="grid grid-cols-2 gap-2.5">
          <ProverOption
            label={t('network_wasm')}
            description={t('network_wasmDesc')}
            icon={Cpu}
            active={state.urls.prover.type === 'wasm'}
            onPick={() => state.setProverType('wasm')}
          />
          <ProverOption
            label={t('network_proofServer')}
            description={t('network_proofServerDesc')}
            icon={Server}
            active={state.urls.prover.type === 'server'}
            onPick={() => state.setProverType('server')}
          />
        </div>
        <p className="m-0 text-[11.5px] leading-relaxed text-muted-foreground">
          {t('network_provingHelp')}
        </p>
        {state.urls.prover.type === 'server' && (
          <UrlField
            label={t('network_proofServerUrl')}
            value={state.urls.prover.url}
            onChange={state.editProverUrl}
          />
        )}
      </div>
    </>
  );
}

function ProverOption({
  label,
  description,
  icon: Icon,
  active,
  onPick,
}: {
  label: string;
  description: string;
  icon: typeof Cpu;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onPick}
      className={`flex cursor-pointer flex-col gap-2 rounded-[14px] border-[1.5px] p-3 text-left transition ${
        active
          ? 'border-secondary bg-accent dark:border-transparent dark:shadow-lift'
          : 'border-border bg-background hover:border-primary dark:border-transparent dark:hover:border-transparent dark:hover:bg-accent/40'
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-bold">
        <Icon size={16} className={active ? 'dark:text-primary' : ''} />
        {label}
      </span>
      <span className="text-[11.5px] text-muted-foreground">{description}</span>
    </button>
  );
}

function NetworkOption({
  id,
  active,
  onPick,
}: {
  id: SupportedNetwork;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onPick}
      className={`group flex w-full cursor-pointer items-center gap-3 rounded-[16px] border-[1.5px] px-3.5 py-3 text-left transition duration-150 active:scale-[0.99] ${
        active
          ? 'border-secondary bg-accent shadow-lift dark:border-transparent'
          : 'border-border bg-card hover:border-primary hover:bg-accent/40 dark:border-transparent dark:hover:border-transparent'
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
          active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:text-foreground'
        }`}
      >
        <Globe size={17} strokeWidth={2.2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold">{NETWORK_LABELS[id]}</span>
        <span className="block text-[12.5px] text-muted-foreground">{t(NETWORK_DESCRIPTIONS[id])}</span>
      </span>
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] ${
          active
            ? 'border-secondary bg-secondary text-secondary-foreground dark:border-transparent dark:bg-primary dark:text-primary-foreground'
            : 'border-border bg-background dark:border-transparent dark:bg-muted'
        }`}
        aria-hidden
      >
        {active && <Check size={12} strokeWidth={3} />}
      </span>
    </button>
  );
}

/** Header name pre-filled for the operator gate we know about. Editable, so a
 *  different endpoint or a renamed header needs no code change. */
export const DEFAULT_AUTH_HEADER_NAME = 'x-shielded-ratelimit-bypass';

function UrlField({
  label,
  value,
  onChange,
  secret = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
      {label}
      <Input
        mono
        className="font-normal"
        // Masked: this is a credential, and the screen gets screenshotted into
        // issues. autoComplete off so it never lands in the browser's saved
        // passwords, where it would outlive the wallet.
        {...(secret ? { type: 'password', autoComplete: 'off', spellCheck: false } : {})}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/** Settings → Network and endpoint configuration for the active account. */
export function NetworkConfig({ onBack, onSaved }: { onBack: () => void; onSaved: () => Promise<void> }) {
  const net = useNetworkConfig();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (resyncApproved: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await sendMessage('networkConfigSave', {
        network: net.network,
        endpoints: normalized(net.urls),
        resyncApproved,
      });
      setConfirming(false);
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('network_saveError'));
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    setError(null);
    if (net.requiresResyncConfirmation) setConfirming(true);
    else void save(false);
  };

  const switchingNetwork = net.networkChanged;

  return (
    <>
      <PanelScreen
        cta={
          <Button size="lg" disabled={!net.valid || !net.changed} loading={saving} onClick={submit}>
            {saving ? t('network_saving') : t('common_save')}
          </Button>
        }
      >
        <PanelHeader title={t('network_title')} onBack={onBack} />
        <p className="m-0 text-[13.5px] text-muted-foreground">
          {t('network_intro')}
        </p>
        <NetworkFields state={net} />
        <NoteCard variant="neutral" icon={RefreshCw}>
          {t('network_resyncNote')}
        </NoteCard>
        {error && !confirming && (
          <p className="m-0 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </PanelScreen>

      <DialogShell
        open={confirming}
        onOpenChange={(open) => {
          if (!saving) setConfirming(open);
        }}
        title={
          net.needsValueWarning
            ? t('network_valueWarningTitle', [networkLabel(net.network)])
            : switchingNetwork
              ? t('network_switchTitle', [networkLabel(net.network)])
              : t('network_changeIndexerTitle')
        }
        actions={
          <>
            <Button variant="outline" disabled={saving} onClick={() => setConfirming(false)}>
              {t('common_cancel')}
            </Button>
            <Button loading={saving} onClick={() => void save(true)}>
              {saving ? t('network_saving') : switchingNetwork ? t('network_switchResync') : t('network_saveResync')}
            </Button>
          </>
        }
      >
        {net.needsValueWarning && (
          <NoteCard variant="error" icon={TriangleAlert} className="mb-3">
            {t('network_valueWarningBody', [networkLabel(net.network)])}
          </NoteCard>
        )}
        <p className="m-0">
          {switchingNetwork
            ? t('network_switchBody', [networkLabel(net.current)])
            : t('network_changeIndexerBody')}{' '}
          {t('network_freshSync', [networkLabel(net.network)])}
        </p>
        <p className="mb-0 mt-2 font-semibold text-foreground">
          {t('network_fundsSafe')}
        </p>
        {error && (
          <p className="mb-0 mt-3 text-destructive" role="alert">
            {error}
          </p>
        )}
      </DialogShell>
    </>
  );
}

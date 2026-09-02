// 2h Settings — Privacy / Addresses / Network / Security / Appearance cards.

import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { t, type MessageKey } from '../../lib/i18n';
import { sendMessage, type ExtensionSettings } from '../../lib/messaging/protocol';
import {
  loadAppearance,
  saveAppearance,
  type Appearance,
  type ThemePreference,
} from '../../lib/ui/theme';
import { cn } from '../../lib/ui/cn';
import { Card, Separator } from '../ui/card';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { DialogShell } from '../ui/dialog';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { networkLabel } from './NetworkConfig';
import { preseedControl } from '../../lib/ui/preseed-control';
import { buildDiagnosticsReport } from '../../lib/ui/diagnostics-report';
import type { Screen } from './navigation';

// Inactivity timeout options. `null` is demo mode (never locks). Kept here (UI
// presentation) rather than imported from the background auto-lock module.
const AUTO_LOCK_CHOICES: ReadonlyArray<{ value: string; minutes: number | null; labelKey: MessageKey }> = [
  { value: '1', minutes: 1, labelKey: 'settings_autoLock1Minute' },
  { value: '5', minutes: 5, labelKey: 'settings_autoLock5Minutes' },
  { value: '15', minutes: 15, labelKey: 'settings_autoLock15Minutes' },
  { value: '30', minutes: 30, labelKey: 'settings_autoLock30Minutes' },
  { value: '60', minutes: 60, labelKey: 'settings_autoLock1Hour' },
  { value: 'never', minutes: null, labelKey: 'settings_autoLockNever' },
];

const THEME_OPTIONS: Array<{ value: ThemePreference; labelKey: MessageKey }> = [
  { value: 'system', labelKey: 'settings_themeSystem' },
  { value: 'light', labelKey: 'settings_themeLight' },
  { value: 'dark', labelKey: 'settings_themeDark' },
];

export function Settings({ onBack, navigate }: { onBack: () => void; navigate: (screen: Screen) => void }) {
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);

  // Reference readiness + live build progress, polled rather than pushed: the
  // build runs for an hour and a bare "in progress" is indistinguishable from
  // stuck. Polling stops once it is ready.
  const [preseed, setPreseed] = useState<{
    ready: boolean;
    height: number | null;
    bundled: boolean;
    building: boolean;
    applied: number;
    total: number;
  } | null>(null);  const [siteCount, setSiteCount] = useState(0);
  const [bookCount, setBookCount] = useState(0);
  // Draft for the name-resolver URL input; saved (and normalized) on blur.
  const [resolverDraft, setResolverDraft] = useState('');
  const [appearance, setAppearance] = useState<Appearance>(() => loadAppearance());
  const [copiedDiagnostics, setCopiedDiagnostics] = useState(false);
  // "Clear cache and resync": confirm first, because it discards an hour of
  // sync on a slow network even though it moves no funds.
  const [confirmingResync, setConfirmingResync] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);

  const resync = async () => {
    setResyncing(true);
    setResyncError(null);
    try {
      await sendMessage('resyncFromScratch', undefined);
      setConfirmingResync(false);
      // The background dropped the snapshot, so the router shows the loading
      // screen for the fresh sync as soon as we leave Settings.
      navigate('home');
    } catch {
      setResyncError(t('settings_resyncError'));
    } finally {
      setResyncing(false);
    }
  };

  const updateAppearance = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    saveAppearance(next);
  };

  const refresh = async () => {
    const [s, grants, book] = await Promise.all([
      sendMessage('settingsGet', undefined),
      sendMessage('permissionsList', undefined),
      sendMessage('addressBookGet', undefined),
    ]);
    setSettings(s);
    setResolverDraft(s.nameResolverUrl ?? '');
    setSiteCount(Object.keys(grants).length);
    setBookCount(book.length);
  };

  // Persist the name-resolver URL; the background normalizes/validates it, so
  // reflect the stored value back (a bad URL is rejected → cleared).
  const saveResolver = async () => {
    const next = await sendMessage('settingsSet', { nameResolverUrl: resolverDraft.trim() || null });
    setSettings(next);
    setResolverDraft(next.nameResolverUrl ?? '');
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Enabling kicks the build off now; it also resumes on unlock while enabled.
  // Fire-and-forget: the build runs for tens of minutes and is meant to be
  // interrupted, so the toggle must not wait on it.
  useEffect(() => {
    void refreshPreseed();
    if (preseedControl(preseed) !== 'offer' || !settings?.preseedWarming) return;
    const id = setInterval(() => void refreshPreseed(), 5_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.preseedWarming, preseed?.ready]);

  const refreshPreseed = async () => {
    try {
      setPreseed(await sendMessage('preseedStatus', undefined));
    } catch {
      /* offscreen not up yet — the next tick retries */
    }
  };

  const setPreseedWarming = async (on: boolean) => {
    setSettings((prev) => (prev ? { ...prev, preseedWarming: on } : prev));
    const next = await sendMessage('settingsSet', { preseedWarming: on });
    setSettings(next);
    if (on) {
      void sendMessage('preseedWarm', undefined).catch(() => {});
      void refreshPreseed();
    }
  };

  // Copy an environment summary for bug reports. Built from settings the panel
  // already holds — no extra round trip — and deliberately excludes addresses,
  // account names and balances, because a user pastes this into a public issue
  // without reading it first. See lib/ui/diagnostics-report.ts.
  const copyDiagnostics = async () => {
    if (!settings) return;
    const report = buildDiagnosticsReport({
      version: browser.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      network: settings.network,
      usesCustomEndpoints: settings.customEndpoints !== null,
      nodeUrl: settings.customEndpoints?.nodeUrl ?? '(preset)',
      indexerUrl: settings.customEndpoints?.indexerUrl ?? '(preset)',
      proverType: settings.customEndpoints?.prover.type ?? 'server',
      proverUrl:
        settings.customEndpoints?.prover.type === 'server' ? settings.customEndpoints.prover.url : undefined,
      hasNodeAuthHeader: settings.customEndpoints?.nodeAuthHeader !== undefined,
      nameResolverUrl: settings.nameResolverUrl,
      autoLockMinutes: settings.autoLockMinutes,
      preseedWarming: settings.preseedWarming,
      developerMode: settings.developerMode,
      preseed: preseed ? { ready: preseed.ready, height: preseed.height, bundled: preseed.bundled } : undefined,
    });
    await navigator.clipboard.writeText(report);
    setCopiedDiagnostics(true);
    setTimeout(() => setCopiedDiagnostics(false), 2_000);
  };

  const setDeveloperMode = async (on: boolean) => {
    setSettings((prev) => (prev ? { ...prev, developerMode: on } : prev));
    setSettings(await sendMessage('settingsSet', { developerMode: on }));
  };

  const setAutoLock = async (minutes: number | null) => {
    // Optimistic: reflect the choice immediately, then persist.
    setSettings((prev) => (prev ? { ...prev, autoLockMinutes: minutes } : prev));
    const next = await sendMessage('settingsSet', { autoLockMinutes: minutes });
    setSettings(next);
  };

  // Which of the three states this network's row is in — see lib/ui/preseed-control.ts
  // for why an on-device build is not offered everywhere any more.
  const control = preseedControl(preseed);

  if (!settings) {
    return (
      <PanelScreen>
        <PanelHeader title={t('settings_title')} onBack={onBack} />
      </PanelScreen>
    );
  }

  return (
    <PanelScreen>
      <PanelHeader title={t('settings_title')} onBack={onBack} />

      <Section label={t('settings_sectionPrivacy')}>
        <button
          onClick={() => navigate('connected-sites')}
          className="group flex w-full cursor-pointer items-center justify-between rounded-[18px] border-0 bg-transparent px-4 py-[15px] text-left text-sm font-medium transition duration-150 hover:bg-muted"
        >
          {t('settings_connectedSites')}
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="text-[13px]">{siteCount}</span>
            <ChevronRight size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
          </span>
        </button>

      </Section>

      <Section label={t('settings_sectionAddresses')}>
        <button
          onClick={() => navigate('address-book')}
          className="group flex w-full cursor-pointer items-center justify-between rounded-[18px] border-0 bg-transparent px-4 py-[15px] text-left text-sm font-medium transition duration-150 hover:bg-muted"
        >
          {t('settings_addressBook')}
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="text-[13px]">{bookCount}</span>
            <ChevronRight size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
          </span>
        </button>
        <div className="flex flex-col gap-1.5 px-4 py-[13px]">
          <span className="block text-sm font-medium">{t('settings_nameResolver')}</span>
          <span className="block text-[12.5px] text-muted-foreground">{t('settings_nameResolverDesc')}</span>
          <Input
            type="url"
            inputMode="url"
            value={resolverDraft}
            onChange={(e) => setResolverDraft(e.target.value)}
            onBlur={() => void saveResolver()}
            placeholder={t('settings_nameResolverPlaceholder')}
            aria-label={t('settings_nameResolver')}
          />
        </div>
      </Section>

      <Section label={t('settings_sectionNetwork')}>
        <button
          onClick={() => navigate('network-config')}
          className="group flex w-full cursor-pointer items-center justify-between rounded-[18px] border-0 bg-transparent px-4 py-[15px] text-left text-sm font-medium transition duration-150 hover:bg-muted"
        >
          {t('settings_networkConfig')}
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="text-[13px]">{networkLabel(settings.network)}</span>
            <ChevronRight size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
          </span>
        </button>
        {control !== 'unknown' && (
          <div className="flex items-center justify-between px-4 py-[13px]">
            <span className="min-w-0 pr-3">
              <span className="block text-sm font-medium">{t('settings_preseedWarming')}</span>
              <span className="block text-[12.5px] text-muted-foreground">
                {control === 'ready'
                  ? t('settings_preseedWarmingDescriptionReady', [networkLabel(settings.network)])
                  : control === 'included'
                    ? t('settings_preseedWarmingDescriptionBundled', [networkLabel(settings.network)])
                    : settings.preseedWarming
                      ? t('settings_preseedWarmingDescriptionOn', [networkLabel(settings.network)])
                      : t('settings_preseedWarmingDescriptionOff', [networkLabel(settings.network)])}
              </span>
            </span>
            {control === 'ready' ? (
              <span className="shrink-0 rounded-full bg-muted px-3 py-1.5 text-[13px] font-semibold text-success">
                {t('settings_preseedWarmingReady')}
              </span>
            ) : control === 'included' ? (
              <span className="shrink-0 rounded-full bg-muted px-3 py-1.5 text-[13px] font-semibold text-muted-foreground">
                {t('settings_preseedWarmingIncluded')}
              </span>
            ) : (
              <span className="relative shrink-0">
                <select
                  aria-label={t('settings_preseedWarmingAria')}
                  value={settings.preseedWarming ? 'on' : 'off'}
                  onChange={(e) => void setPreseedWarming(e.target.value === 'on')}
                  className="cursor-pointer appearance-none rounded-full bg-muted py-1.5 pl-3 pr-8 text-[13px] font-semibold text-foreground focus:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/70"
                >
                  <option value="off">{t('settings_preseedWarmingOff')}</option>
                  <option value="on">
                    {settings.preseedWarming && preseed && preseed.total > 0
                      ? t('settings_preseedWarmingProgress', [
                          Math.min(99, Math.floor((preseed.applied / preseed.total) * 100)),
                        ])
                      : t('settings_preseedWarmingOn')}
                  </option>
                </select>
                <ChevronDown
                  size={14}
                  strokeWidth={2.5}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                />
              </span>
            )}
          </div>
        )}
        <div className="flex items-center justify-between px-4 py-[13px]">
          <span className="min-w-0 pr-3">
            <span className="block text-sm font-medium">{t('settings_resync')}</span>
            <span className="block text-[12.5px] text-muted-foreground">
              {t('settings_resyncDescription', [networkLabel(settings.network)])}
            </span>
          </span>
          <Button size="sm" variant="secondary" className="shrink-0" onClick={() => setConfirmingResync(true)}>
            {t('settings_resyncButton')}
          </Button>
        </div>
        <div className="flex items-center justify-between px-4 py-[13px]">
          <span className="min-w-0 pr-3">
            <span className="block text-sm font-medium">{t('settings_developerMode')}</span>
            <span className="block text-[12.5px] text-muted-foreground">
              {t('settings_developerModeDescription')}
            </span>
          </span>
          <span className="relative shrink-0">
            <select
              aria-label={t('settings_developerModeAria')}
              value={settings.developerMode ? 'on' : 'off'}
              onChange={(e) => void setDeveloperMode(e.target.value === 'on')}
              className="cursor-pointer appearance-none rounded-full bg-muted py-1.5 pl-3 pr-8 text-[13px] font-semibold text-foreground focus:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/70"
            >
              <option value="off">{t('settings_developerModeOff')}</option>
              <option value="on">{t('settings_developerModeOn')}</option>
            </select>
            <ChevronDown
              size={14}
              strokeWidth={2.5}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
          </span>
        </div>
      </Section>

      <Section label={t('settings_sectionSecurity')}>
        <div className="flex items-center justify-between px-4 py-[13px]">
          <span className="min-w-0 pr-3">
            <span className="block text-sm font-medium">{t('settings_autoLock')}</span>
            <span className="block text-[12.5px] text-muted-foreground">
              {settings.autoLockMinutes === null
                ? t('settings_autoLockDemo')
                : t('settings_autoLockDescription')}
            </span>
          </span>
          {/* appearance-none + own chevron: the native caret sits off the pill's centerline */}
          <span className="relative shrink-0">
            <select
              aria-label={t('settings_autoLockAria')}
              value={settings.autoLockMinutes === null ? 'never' : String(settings.autoLockMinutes)}
              onChange={(e) => {
                const choice = AUTO_LOCK_CHOICES.find((c) => c.value === e.target.value);
                void setAutoLock(choice ? choice.minutes : 15);
              }}
              className="cursor-pointer appearance-none rounded-full bg-muted py-1.5 pl-3 pr-8 text-[13px] font-semibold text-foreground focus:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/70"
            >
              {AUTO_LOCK_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {t(c.labelKey)}
                </option>
              ))}
            </select>
            <ChevronDown
              size={14}
              strokeWidth={2.5}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
          </span>
        </div>
      </Section>

      <Section label={t('settings_sectionAppearance')}>
        <div className="flex items-center justify-between px-4 py-[13px]">
          <span className="text-sm font-medium">{t('settings_theme')}</span>
          <div className="flex rounded-full bg-muted p-1" role="radiogroup" aria-label={t('settings_theme')}>
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                role="radio"
                aria-checked={appearance.theme === option.value}
                onClick={() => updateAppearance({ theme: option.value })}
                className={cn(
                  'cursor-pointer rounded-full border-0 px-3 py-1.5 text-[12.5px] font-semibold transition duration-150',
                  appearance.theme === option.value
                    ? 'bg-card text-foreground shadow-lift dark:bg-primary dark:text-primary-foreground'
                    : 'bg-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </div>
        <Separator />
        <button
          role="switch"
          aria-checked={appearance.colorblind}
          onClick={() => updateAppearance({ colorblind: !appearance.colorblind })}
          className="flex w-full cursor-pointer items-center justify-between border-0 bg-transparent px-4 py-[15px] text-left transition duration-150 hover:bg-muted"
        >
          <span className="min-w-0 pr-3">
            <span className="block text-sm font-medium">{t('settings_colorblind')}</span>
            <span className="block text-[12.5px] text-muted-foreground">
              {t('settings_colorblindDescription')}
            </span>
          </span>
          <span
            aria-hidden
            className={cn(
              'relative h-6 w-10 shrink-0 rounded-full transition-colors duration-150',
              appearance.colorblind ? 'bg-primary' : 'bg-border',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 h-5 w-5 rounded-full bg-card shadow-lift transition-all duration-150',
                appearance.colorblind ? 'left-[18px]' : 'left-0.5',
              )}
            />
          </span>
        </button>
      </Section>

      <Section label={t('settings_sectionSupport')}>
        <div className="flex items-center justify-between px-4 py-[13px]">
          <span className="min-w-0 pr-3">
            <span className="block text-sm font-medium">{t('settings_copyDiagnostics')}</span>
            <span className="block text-[12.5px] text-muted-foreground">{t('settings_copyDiagnosticsDesc')}</span>
          </span>
          <Button size="sm" variant="secondary" className="shrink-0" onClick={() => void copyDiagnostics()}>
            {copiedDiagnostics ? t('settings_copyDiagnosticsDone') : t('settings_copyDiagnostics')}
          </Button>
        </div>
      </Section>

      <p className="m-0 pb-2 text-center text-xs text-muted-foreground">
        {t('settings_version', [browser.runtime.getManifest().version])}
      </p>

      <DialogShell
        open={confirmingResync}
        onOpenChange={(open) => {
          if (!resyncing) setConfirmingResync(open);
        }}
        title={t('settings_resyncTitle')}
        actions={
          <>
            <Button variant="outline" disabled={resyncing} onClick={() => setConfirmingResync(false)}>
              {t('common_cancel')}
            </Button>
            <Button loading={resyncing} onClick={() => void resync()}>
              {resyncing ? t('settings_resyncWorking') : t('settings_resyncConfirm')}
            </Button>
          </>
        }
      >
        <p className="m-0">{t('settings_resyncBody', [networkLabel(settings.network)])}</p>
        {resyncError && (
          <p className="mb-0 mt-3 text-destructive" role="alert">
            {resyncError}
          </p>
        )}
      </DialogShell>
    </PanelScreen>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="section-label mb-2">{label}</p>
      <Card className="p-0">{children}</Card>
    </div>
  );
}

import { Settings as SettingsIcon } from 'lucide-react';
import { t } from '../../lib/i18n';
import { PanelScreen, OrbitingMoth } from '../moth/panel';
import { NetworkBadge } from './Home';

function loadingDetail(syncMessage: string): string {
  const message = syncMessage.toLowerCase();

  if (message.includes('dust') || message.includes('unshielded') || message.includes('shielded')) {
    return t('welcome_loadingPreparingWallet');
  }
  if (message.includes('network') || message.includes('catching up')) return t('welcome_loadingCatchingUp');
  if (message.includes('reference') || message.includes('pre-seed')) return t('welcome_loadingPreparingNewWallet');
  if (message.includes('facade')) return t('welcome_loadingStartingServices');

  return t('welcome_loadingOpeningWallet');
}

/** Full-panel interstitial shown until the first complete balance snapshot is
 * available. It keeps half-restored account values out of view while the SDK
 * rebuilds its shielded, unshielded, and DUST state.
 *
 * That rebuild takes minutes on a large chain, so an unlocked wallet gets the
 * network it is loading and a way into Settings: the user who opened the wrong
 * network must be able to leave it without waiting for it to finish. */
export function WalletLoading({
  syncMessage,
  network,
  onSettings,
}: {
  syncMessage: string;
  network?: string;
  onSettings?: () => void;
}) {
  return (
    <PanelScreen dark className="relative isolate overflow-hidden">
      {(network || onSettings) && (
        <div className="flex items-center gap-2 pt-[18px]">
          {network && <NetworkBadge network={network} />}
          {onSettings && (
            <button
              onClick={onSettings}
              className="group ml-auto flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-0 bg-muted transition duration-150 hover:bg-border active:scale-90"
              aria-label={t('home_settingsAria')}
            >
              <SettingsIcon
                size={16}
                strokeWidth={2}
                className="transition-transform duration-300 ease-out group-hover:rotate-90"
              />
            </button>
          )}
        </div>
      )}

      <div className="flex flex-1 flex-col items-center justify-center px-2 text-center" role="status" aria-live="polite">
        <div className="mb-7">
          <OrbitingMoth />
        </div>

        <h1 className="m-0 font-display text-[30px] font-extrabold leading-tight">{t('welcome_gettingThingsReady')}</h1>
        <p className="mb-0 mt-2 min-h-5 text-[13.5px] text-muted-foreground">{loadingDetail(syncMessage)}</p>

        <div className="mt-6 flex items-center gap-1.5" aria-hidden>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:-400ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary [animation-delay:-200ms]" />
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        </div>
      </div>
    </PanelScreen>
  );
}

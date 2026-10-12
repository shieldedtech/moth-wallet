import { Settings as SettingsIcon } from 'lucide-react';
import { t } from '../../lib/i18n';
import { SYNC_FAILURE_PREFIX } from '../../lib/messaging/protocol';
import { PanelScreen, OrbitingMoth } from '../moth/panel';
import { Button } from '../ui/button';
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
  slow = false,
  onOpenNetwork,
}: {
  syncMessage: string;
  network?: string;
  onSettings?: () => void;
  /**
   * True once this interstitial has been up long enough that "still
   * starting up" no longer explains it — see useSlowSync in lib/ui/client.ts,
   * which is what actually times this. A sync that never connects (wrong
   * network selected, an unreachable endpoint, or a subsystem that reports
   * progress but never finishes) does not throw, so `failure` below never
   * fires — without this, that case has no error and no route out.
   */
  slow?: boolean;
  /** Present so a failure (or a slow sync, see `slow`) is not a dead end. */
  onOpenNetwork?: () => void;
}) {
  // A failure is not a slow step. Without this it falls through loadingDetail's
  // keyword matching to "Opening your secure wallet" and spins forever, which
  // is the same fault the message was added to surface.
  const failure = syncMessage.startsWith(SYNC_FAILURE_PREFIX)
    ? syncMessage.slice(SYNC_FAILURE_PREFIX.length).trim()
    : null;

  if (failure) {
    return (
      <PanelScreen dark className="relative isolate overflow-hidden">
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center" role="alert">
          <h1 className="m-0 font-display text-[30px] font-extrabold leading-tight">
            {t('welcome_loadingFailedTitle')}
          </h1>
          <p className="mb-0 mt-2 text-[13.5px] text-muted-foreground">{failure}</p>
          <p className="mb-0 mt-4 text-[12.5px] text-muted-foreground">{t('welcome_loadingFailedHint')}</p>
          {onOpenNetwork ? (
            <Button variant="secondary" size="lg" className="mt-6" onClick={onOpenNetwork}>
              {t('welcome_loadingFailedAction')}
            </Button>
          ) : null}
        </div>
      </PanelScreen>
    );
  }

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

        {slow && (
          <>
            <p className="mb-0 mt-4 text-[12.5px] text-muted-foreground">{t('welcome_loadingFailedHint')}</p>
            {onOpenNetwork ? (
              <Button variant="secondary" size="lg" className="mt-4" onClick={onOpenNetwork}>
                {t('welcome_loadingFailedAction')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </PanelScreen>
  );
}

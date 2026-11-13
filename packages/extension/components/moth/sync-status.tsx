import { useEffect, useReducer, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { t } from '../../lib/i18n';
import { DUST_WALLET_LABEL } from '../../lib/ui/token-labels';

export interface SyncStatusView {
  /** Percent 0-100 per sub-wallet. */
  shielded: number;
  unshielded: number;
  dust: number;
  /**
   * Estimated seconds remaining, or null when not yet estimable.
   *
   * Computed in core against the SLOWEST sub-wallet with a baseline correction
   * for resumed syncs, so it is meaningful for a long rebuild. Surfaced here
   * because a rescan with no duration signal leaves the user unable to tell a
   * slow job from a stuck one.
   */
  etaSeconds?: number | null;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

/** A coarse ETA, as a unit and a value the caller localises. */
export type EtaDisplay =
  | { unit: 'seconds'; value: number }
  | { unit: 'minutes'; value: number }
  | { unit: 'hours'; value: number }
  | { unit: 'hoursMinutes'; value: number; minutes: number };

/**
 * Coarse duration for an ETA. Deliberately rounded: the estimate is a rate
 * extrapolation, so finer precision would imply accuracy it does not have.
 *
 * Returns null when there is nothing worth showing, so callers render nothing
 * rather than a misleading "0s". The unit is returned rather than a formatted
 * string because the caller has the message catalog — a hard-coded "min" inside
 * a localised sentence reaches de/es/fr as English.
 *
 * Seconds hand over to minutes at 60, and are capped at 55, so the scale never
 * reads "~60s" one tick before "~1 min". Rounding minutes at a 90s cutoff put
 * "~90s" next to "~2 min" for a one-second difference.
 */
export function etaDisplay(seconds: number | null | undefined): EtaDisplay | null {
  if (seconds === null || seconds === undefined || seconds <= 0) return null;
  if (seconds < 60) {
    return { unit: 'seconds', value: Math.max(5, Math.min(55, Math.round(seconds / 5) * 5)) };
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return { unit: 'minutes', value: minutes };
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? { unit: 'hours', value: hours } : { unit: 'hoursMinutes', value: hours, minutes: rem };
}

/** The same value as a localised string. */
function etaText(eta: EtaDisplay | null): string | null {
  if (!eta) return null;
  switch (eta.unit) {
    case 'seconds':
      return t('syncStatus_etaSeconds', [eta.value]);
    case 'minutes':
      return t('syncStatus_etaMinutes', [eta.value]);
    case 'hours':
      return t('syncStatus_etaHours', [eta.value]);
    case 'hoursMinutes':
      return t('syncStatus_etaHoursMinutes', [eta.value, eta.minutes]);
  }
}

/**
 * Once synced, give the wallet a few progressive emissions to catch a newly
 * advanced tip before changing the top-bar status back to "Syncing".
 */
export const SYNC_REGRESSION_GRACE_MS = 3_000;

export interface SyncDisplayState {
  hasSynced: boolean;
  synced: boolean;
  waitingForRegression: boolean;
}

export type SyncDisplayAction =
  | { type: 'source'; synced: boolean; fraction?: number }
  | { type: 'regressionGraceElapsed' }
  | { type: 'reset' };

export function initialSyncDisplayState(synced: boolean): SyncDisplayState {
  return { hasSynced: synced, synced, waitingForRegression: false };
}

export function syncDisplayReducer(
  state: SyncDisplayState,
  action: SyncDisplayAction,
): SyncDisplayState {
  if (action.type === 'reset') return initialSyncDisplayState(false);

  if (action.type === 'regressionGraceElapsed') {
    return state.waitingForRegression
      ? { ...state, synced: false, waitingForRegression: false }
      : state;
  }

  if (action.synced) {
    return state.synced && state.hasSynced && !state.waitingForRegression
      ? state
      : { hasSynced: true, synced: true, waitingForRegression: false };
  }

  if (!state.hasSynced) {
    return state.synced || state.waitingForRegression
      ? { hasSynced: false, synced: false, waitingForRegression: false }
      : state;
  }

  // A large drop is a rebuild or a genuine resync, not a tip advance: report it
  // at once rather than waiting out the grace. Decided here rather than in the
  // hook's effect so it is pure — and so the fraction never has to be an effect
  // dependency, which would re-arm the grace timer on every emission.
  if (action.fraction !== undefined && action.fraction < REAL_REGRESSION_BELOW) {
    return initialSyncDisplayState(false);
  }

  return state.waitingForRegression
    ? state
    : { ...state, waitingForRegression: true };
}

/**
 * Below this fraction a regression is treated as REAL and reported at once,
 * skipping the grace period.
 *
 * The grace exists to stop ordinary tip advances flashing syncing UI — those
 * dip a fraction of a percent. A deliberate cache rebuild drops progress to
 * near zero, and holding "Synced · 100%" over minutes of genuine rescanning is
 * the opposite of what the user needs: they asked for the rebuild and have no
 * other signal for how long it will take.
 */
export const REAL_REGRESSION_BELOW = 0.9;

/**
 * Show a newly synced state immediately, but delay regressions after the first
 * successful sync so ordinary tip advances do not flash syncing UI.
 *
 * Pass `rawPercentage` (0..1) so a large drop — a cache rebuild — bypasses the
 * grace instead of being smoothed over.
 */
export function useSyncRegressionGrace(
  rawSynced: boolean,
  active = true,
  rawPercentage?: number,
): boolean {
  const [displayState, dispatchDisplay] = useReducer(
    syncDisplayReducer,
    rawSynced,
    initialSyncDisplayState,
  );
  const fractionRef = useRef(rawPercentage);
  fractionRef.current = rawPercentage;

  useEffect(() => {
    if (!active) {
      dispatchDisplay({ type: 'reset' });
      return;
    }

    dispatchDisplay({ type: 'source', synced: rawSynced, fraction: fractionRef.current });
    if (rawSynced || !displayState.hasSynced) return;

    const timeout = setTimeout(
      () => dispatchDisplay({ type: 'regressionGraceElapsed' }),
      SYNC_REGRESSION_GRACE_MS,
    );
    return () => clearTimeout(timeout);
    // `rawPercentage` is read through a ref and deliberately absent here. As a
    // dependency it re-ran this effect on every ~1s emission, clearing the
    // pending timeout and arming a fresh one, so a regression that kept making
    // progress never reached regressionGraceElapsed and the wallet showed
    // "Synced" for the whole catch-up.
  }, [active, rawSynced, displayState.hasSynced]);

  return active && (rawSynced || displayState.synced);
}

/**
 * Compact sync indicator for the panel top bar: a sand pill with a spinner
 * and the overall percent while syncing, a lime check circle and "Synced"
 * once every sub-wallet is done. Clicking toggles a right-aligned popover
 * with per-wallet progress bars; clicking outside closes it.
 * @category feedback
 */
export function SyncStatus({
  view,
  defaultOpen = false,
}: {
  view: SyncStatusView;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);

  const shielded = clamp(view.shielded);
  const unshielded = clamp(view.unshielded);
  const dust = clamp(view.dust);
  const rawOverall = Math.round((shielded + unshielded + dust) / 3);
  const rawSynced = rawOverall >= 100;
  // Pass the raw fraction so a rebuild's large drop bypasses the grace instead
  // of being smoothed into a false "Synced · 100%".
  const synced = useSyncRegressionGrace(rawSynced, true, rawOverall / 100);

  // Keep the expanded detail consistent with the top-bar status during the
  // grace period instead of showing "Synced" beside temporarily lower rows.
  const visibleShielded = synced && !rawSynced ? 100 : shielded;
  const visibleUnshielded = synced && !rawSynced ? 100 : unshielded;
  const visibleDust = synced && !rawSynced ? 100 : dust;
  const overall = synced && !rawSynced ? 100 : rawOverall;
  // Suppressed during the grace period: an ETA beside a "Synced" pill reads as
  // a contradiction.
  const eta = synced ? null : etaText(etaDisplay(view.etaSeconds));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-9 cursor-pointer items-center gap-2 rounded-full border-0 bg-muted px-3"
        aria-label={synced ? t('syncStatus_synced') : t('syncStatus_syncingAria', [overall])}
      >
        {synced ? (
          <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check size={10} strokeWidth={3} />
          </span>
        ) : (
          <LoaderCircle size={14} strokeWidth={2.5} className="animate-spin text-link" />
        )}
        <span className="text-[12.5px] font-semibold">
          {synced ? t('syncStatus_synced') : t('syncStatus_percent', [overall])}
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-[44px] z-40 w-[272px] rounded-[18px] border border-border bg-card p-3.5 shadow-float">
          <div className="mb-[11px] flex items-baseline justify-between">
            <span className="text-[13px] font-semibold">
              {synced ? t('syncStatus_synced') : t('syncStatus_syncing')}
            </span>
            {!synced && (
              <span className="text-[12.5px] text-muted-foreground">
                {t('syncStatus_percent', [overall])}
                {/* Only while genuinely syncing, and only when estimable. */}
                {eta && <span className="ml-1.5">{eta}</span>}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-[11px]">
            <ProgressRow label={t('syncStatus_shielded')} percent={visibleShielded} />
            <ProgressRow label={t('syncStatus_unshielded')} percent={visibleUnshielded} />
            <ProgressRow label={DUST_WALLET_LABEL} percent={visibleDust} />
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressRow({ label, percent }: { label: string; percent: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[76px] text-[12.5px] font-semibold">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </span>
      <span className="w-9 text-right text-[12.5px] text-muted-foreground">{t('syncStatus_percent', [percent])}</span>
    </div>
  );
}

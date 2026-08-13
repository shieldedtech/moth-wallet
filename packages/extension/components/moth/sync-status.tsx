import { useEffect, useReducer, useRef, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { t } from '../../lib/i18n';
import { DUST_WALLET_LABEL } from '../../lib/ui/token-labels';

export interface SyncStatusView {
  /** Percent 0-100 per sub-wallet. */
  shielded: number;
  unshielded: number;
  dust: number;
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

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
  | { type: 'source'; synced: boolean }
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

  return state.waitingForRegression
    ? state
    : { ...state, waitingForRegression: true };
}

/**
 * Show a newly synced state immediately, but delay regressions after the first
 * successful sync so ordinary tip advances do not flash syncing UI.
 */
export function useSyncRegressionGrace(rawSynced: boolean, active = true): boolean {
  const [displayState, dispatchDisplay] = useReducer(
    syncDisplayReducer,
    rawSynced,
    initialSyncDisplayState,
  );

  useEffect(() => {
    if (!active) {
      dispatchDisplay({ type: 'reset' });
      return;
    }

    dispatchDisplay({ type: 'source', synced: rawSynced });
    if (rawSynced || !displayState.hasSynced) return;

    const timeout = setTimeout(
      () => dispatchDisplay({ type: 'regressionGraceElapsed' }),
      SYNC_REGRESSION_GRACE_MS,
    );
    return () => clearTimeout(timeout);
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
  const synced = useSyncRegressionGrace(rawSynced);

  // Keep the expanded detail consistent with the top-bar status during the
  // grace period instead of showing "Synced" beside temporarily lower rows.
  const visibleShielded = synced && !rawSynced ? 100 : shielded;
  const visibleUnshielded = synced && !rawSynced ? 100 : unshielded;
  const visibleDust = synced && !rawSynced ? 100 : dust;
  const overall = synced && !rawSynced ? 100 : rawOverall;

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
              <span className="text-[12.5px] text-muted-foreground">{t('syncStatus_percent', [overall])}</span>
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

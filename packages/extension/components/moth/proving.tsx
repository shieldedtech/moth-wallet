// Progress for a transaction in flight. Local (WASM) proving runs for minutes with
// nothing else to observe, so the note moves: a beating moth and a counting clock.
// Shared by the send and DUST pending screens and Home's background banner.

import { useEffect, useRef, useState } from 'react';
import type { TxStage } from '@shieldedtech/moth-browser';
import { t } from '../../lib/i18n';
import { formatElapsed } from '../../lib/ui/format';
import type { ProverType } from '../../lib/ui/proving-method';
import { MothMark } from './panel';

/** "m:ss" since `since`, ticking every second; null when nothing is running. */
export function useElapsed(since: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [since]);
  if (since === null) return null;
  return formatElapsed(now - since);
}

/**
 * The stage to display while an op's own screen is up: the background clears the stage a
 * beat before the op's promise settles, so hold the last one rather than snap to step one.
 */
export function useLatchedStage(txStage: TxStage | null): TxStage | null {
  const last = useRef<TxStage | null>(txStage);
  if (txStage !== null) last.current = txStage;
  return last.current;
}

/** Sub-line for the proving step; local proving gets the expectation copy and the clock. */
export function ProvingNote({
  proverType,
  since,
  active,
}: {
  proverType: ProverType | null;
  /** When the proving stage began; drives the clock. */
  since: number | null;
  /** Whether proving is the current stage (the clock and moth show only then). */
  active: boolean;
}) {
  const elapsed = useElapsed(active ? since : null);
  if (proverType !== 'wasm') {
    return <>{proverType === 'server' ? t('status_provingServer') : t('status_provingLoading')}</>;
  }
  return (
    <span className="flex flex-col gap-1">
      <span>{t('status_provingLocal')}</span>
      <span>{t('status_provingLocalDetail')}</span>
      {active && (
        <span className="mt-0.5 flex items-center gap-1.5 text-foreground/80" role="status" aria-live="polite">
          <MothMark size={16} />
          <span className="tabular-nums">{t('status_elapsed', [elapsed ?? formatElapsed(0)])}</span>
        </span>
      )}
    </span>
  );
}

const STAGE_LINE: Record<TxStage, () => string> = {
  building: () => t('status_backgroundBuilding'),
  proving: () => t('status_backgroundProving'),
  submitting: () => t('status_backgroundSubmitting'),
};

/**
 * Home banner for an operation running with no screen of its own; renders nothing when idle.
 * @category feedback
 */
export function BackgroundActivity({
  stage,
  since,
  proverType,
}: {
  stage: TxStage | null;
  since: number | null;
  proverType: ProverType | null;
}) {
  const elapsed = useElapsed(stage === null ? null : since);
  if (stage === null) return null;
  const local = stage === 'proving' && proverType === 'wasm';
  return (
    <div className="flex items-start gap-3 rounded-[14px] bg-muted p-3.5" role="status" aria-live="polite">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center">
        <MothMark size={28} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[13px] font-semibold leading-[1.4]">{t('status_backgroundTitle')}</p>
        <p className="m-0 text-[13px] leading-[1.4] text-muted-foreground">
          {STAGE_LINE[stage]()}
          {elapsed && <span className="ml-1.5 tabular-nums text-foreground/70">{t('status_elapsed', [elapsed])}</span>}
        </p>
        <p className="m-0 text-[12px] leading-[1.4] text-muted-foreground">
          {local ? t('status_provingLocal') : t('status_backgroundHint')}
        </p>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { CloudOff } from 'lucide-react';
import { Button } from '../ui/button';
import { t } from '../../lib/i18n';
import { useDeveloperMode } from '../../lib/ui/client';
import { sendMessage } from '../../lib/messaging/protocol';
import type { RelayState } from '../../lib/messaging/protocol';

/**
 * Node-relay outage banner.
 *
 * Shown to every user, not just developers: the relay is what broadcasts
 * transactions, so while it is down a send will fail, and discovering that at
 * the end of a signing flow is worse than being told up front. What the banner
 * does NOT do is imply the wallet is broken — the indexer drives sync
 * independently, so balances remain correct throughout, and the copy says so.
 *
 * Developer mode adds the endpoint, the HTTP status behind the failure, and the
 * retry counters. That detail is the difference between "the wallet is having
 * trouble" and "this endpoint returns 403 to everyone", which is not a
 * distinction to put in front of every user but is the whole answer for anyone
 * debugging one.
 *
 * @category feedback
 */
export function RelayStatus({ state }: { state: RelayState | null | undefined }) {
  const [retrying, setRetrying] = useState(false);
  const developerMode = useDeveloperMode();

  // `reason === 'reachable'` means the probe got an HTTP answer, so the endpoint
  // is up whatever the socket did. Never contradict that on screen — the earlier
  // version showed "Can't reach the node" above the HTTP 405 disproving it.
  // Undefined as well as null: the panel mounts before the first relay event,
  // and Home renders this unconditionally.
  if (!state || state.status !== 'unreachable' || state.reason === 'reachable') return null;

  const forbidden = state.reason === 'forbidden';

  const retry = async () => {
    setRetrying(true);
    try {
      await sendMessage('relayRetry', undefined);
    } catch {
      /* the banner is already reporting the failure this would report */
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-[14px] bg-error-tint p-3.5 text-error-text">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <CloudOff size={14} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[13px] font-semibold leading-[1.4]">
          {forbidden ? t('relay_forbiddenTitle') : t('relay_unreachableTitle')}
        </p>
        <p className="m-0 text-[13px] leading-[1.4]">
          {forbidden ? t('relay_forbiddenBody') : t('relay_unreachableBody')}
        </p>
        {developerMode && <RelayDetail state={state} />}
      </div>
      <Button variant="soft-destructive" size="sm" loading={retrying} onClick={() => void retry()}>
        {retrying ? t('relay_retrying') : t('relay_retry')}
      </Button>
    </div>
  );
}

/** Developer-mode detail: endpoint, status, attempts, live countdown. */
function RelayDetail({ state }: { state: RelayState }) {
  const seconds = useCountdown(state.nextRetryAt);

  const status = state.httpStatus === null ? t('relay_detailNoStatus') : t('relay_detailStatus', [String(state.httpStatus)]);
  const attempts = state.attempts === 1 ? t('relay_detailAttemptsOne') : t('relay_detailAttempts', [String(state.attempts)]);
  const next = seconds === null || seconds <= 0 ? t('relay_detailNextRetryNow') : t('relay_detailNextRetry', [String(seconds)]);

  return (
    <div className="mt-1.5 flex flex-col gap-0.5 text-[11.5px] opacity-80">
      {/* break-all, not truncate: a URL is only diagnostic if it can be read in
          full, and the panel is narrow enough that any endpoint would elide. */}
      <span className="break-all font-mono">{state.url}</span>
      <span>
        {status} · {attempts} · {next}
      </span>
    </div>
  );
}

/**
 * Whole seconds until `at`, ticking once a second, or null when there is no
 * deadline. Driven locally rather than from pushed state: the backoff can sit at
 * 60s and a countdown that only moved when the background spoke would look
 * frozen for a minute at a time.
 */
function useCountdown(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (at === null) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [at]);

  if (at === null) return null;
  return Math.max(0, Math.ceil((at - now) / 1_000));
}

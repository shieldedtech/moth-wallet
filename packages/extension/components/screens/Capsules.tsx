// The capsule inspector: the unlocked account's capsules, each with the contract it holds private
// state for, the code that address resolved to and how many transactions have folded in, each
// opening in full; then what is still in flight. Read from the runtime in the wallet worker; it
// changes when the chain answers, not before.

import { useCallback, useEffect, useState } from 'react';
import { Box, ChevronRight } from 'lucide-react';
import { t } from '../../lib/i18n';
import { sendMessage } from '../../lib/messaging/protocol';
import type { CapsuleInspectorDTO } from '../../lib/capsule/protocol';
import { Button } from '../ui/button';
import { Card, Separator } from '../ui/card';
import { PanelScreen, PanelHeader } from '../moth/panel';
import { CapsuleDetail } from './CapsuleDetail';

const short = (hex: string) => (hex.length > 18 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex);

export function Capsules({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<CapsuleInspectorDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setView(await sendMessage('capsuleList', undefined));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The opened capsule is read from the latest view, so a refresh behind it shows through.
  const detail = opened === null ? undefined : view?.capsules.find((capsule) => capsule.address === opened);
  if (detail !== undefined) {
    return <CapsuleDetail capsule={detail} onBack={() => setOpened(null)} />;
  }

  return (
    <PanelScreen
      cta={
        <Button size="lg" onClick={() => void refresh()}>
          {t('capsule_inspectorRefresh')}
        </Button>
      }
    >
      <PanelHeader title={t('capsule_inspectorTitle')} onBack={onBack} />
      {error && <p className="m-0 text-[13px] text-destructive">{t('capsule_inspectorError', [error])}</p>}
      {view && view.capsules.length === 0 && (
        <div className="flex flex-col items-center gap-3 pt-16 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <Box size={24} className="text-muted-foreground" />
          </span>
          <p className="m-0 font-display text-lg font-bold">{t('capsule_inspectorEmptyTitle')}</p>
          <p className="m-0 text-[13px] text-muted-foreground">{t('capsule_inspectorEmptyBody')}</p>
        </div>
      )}
      {view && view.capsules.length > 0 && (
        <Card className="p-0">
          {view.capsules.map((capsule, index) => (
            <div key={capsule.address}>
              {index > 0 && <Separator />}
              <button
                type="button"
                onClick={() => setOpened(capsule.address)}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-[13px] text-left hover:bg-muted/50"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="block text-sm font-semibold">{capsule.bundle}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{short(capsule.address)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('capsule_buildLabel')} {short(capsule.fingerprint)} · {t('capsule_foldedCount', [capsule.folded])}
                    {capsule.inFlight.length > 0 && ` · ${t('capsule_inFlightCount', [capsule.inFlight.length])}`}
                  </span>
                </span>
                <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
              </button>
            </div>
          ))}
        </Card>
      )}
      {view && view.pending.length > 0 && (
        <>
          <p className="m-0 pt-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{t('capsule_inFlightTitle')}</p>
          <Card className="p-0">
            {view.pending.map((tx, index) => (
              <div key={tx.identifier}>
                {index > 0 && <Separator />}
                <div className="px-4 py-[13px]">
                  <span className="block font-mono text-xs">{short(tx.identifier)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('capsule_inFlightLine', [
                      tx.calls.map((call) => `${call.circuit} @ ${short(call.address)}`).join(', '),
                      new Date(tx.submittedAt).toLocaleTimeString(),
                      new Date(tx.ttl).toLocaleTimeString(),
                    ])}
                  </span>
                </div>
              </div>
            ))}
          </Card>
        </>
      )}
    </PanelScreen>
  );
}

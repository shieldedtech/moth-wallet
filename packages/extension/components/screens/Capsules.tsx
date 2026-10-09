// The capsule inspector: the unlocked account's capsules, each with the contract it holds private
// state for, the code that address resolved to, how many transactions have folded in, and its
// fields rendered as a dApp reads them; then what is still in flight. Read from the runtime in the
// wallet worker; it changes when the chain answers, not before.

import { useCallback, useEffect, useState } from 'react';
import { Box } from 'lucide-react';
import { t } from '../../lib/i18n';
import { sendMessage } from '../../lib/messaging/protocol';
import type { CapsuleInspectorDTO } from '../../lib/capsule/protocol';
import { Button } from '../ui/button';
import { Card, Separator } from '../ui/card';
import { PanelScreen, PanelHeader } from '../moth/panel';

const short = (hex: string) => (hex.length > 18 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex);

/** A field as the screen shows it: the JSON a dApp reads, a collection counted first. */
function shown(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? 'empty' : `${value.length}: ${value.map((item) => JSON.stringify(item)).join(', ')}`;
  }
  return JSON.stringify(value);
}

export function Capsules({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<CapsuleInspectorDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

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
              <div className="px-4 py-[13px]">
                <span className="block text-sm font-semibold">{capsule.bundle}</span>
                <span className="block font-mono text-xs text-muted-foreground">{short(capsule.address)}</span>
                <span className="block text-xs text-muted-foreground">
                  {t('capsule_buildLabel')} {short(capsule.fingerprint)} · {t('capsule_foldedCount', [capsule.folded])}
                </span>
                {Object.entries(capsule.fields).map(([name, value]) => (
                  <span key={name} className="block break-all font-mono text-xs">
                    {name}: {shown(value)}
                  </span>
                ))}
              </div>
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
